import type { Config } from "../config";
import type { Context } from "../context";
import { createEdge } from "../edges";
import { UserError } from "../errors";
import type { Db } from "../sqlite";

/** Cross-kind temporal proximity is scoped to the health kinds (SPEC §5.1). */
const HEALTH_KINDS = ["meal", "symptom", "visit", "lab_result"];

type Candidate = { src: string; dst: string; score: number; reason: string };

/** Calendar-day distance on occurred_at→created_at, canonical a.id < b.id. */
function temporalCandidates(db: Db, windows: string[]): Candidate[] {
  const marks = HEALTH_KINDS.map(() => "?").join(", ");
  const day = (alias: string) =>
    `julianday(date(COALESCE(${alias}.occurred_at, ${alias}.created_at)))`;
  const rows = db.all(
    `SELECT a.id AS src, b.id AS dst,
            CAST(ABS(${day("b")} - ${day("a")}) AS INTEGER) AS day_diff
     FROM nodes a
     JOIN nodes b ON a.id < b.id AND a.kind != b.kind
     WHERE a.kind IN (${marks}) AND b.kind IN (${marks})
       AND a.deleted_at IS NULL AND b.deleted_at IS NULL
       AND ABS(${day("b")} - ${day("a")}) <= 1
     ORDER BY a.id, b.id`,
    ...HEALTH_KINDS,
    ...HEALTH_KINDS
  );
  const out: Candidate[] = [];
  for (const r of rows) {
    const window = (r.day_diff as number) === 0 ? "same-day" : "next-day";
    if (!windows.includes(window)) continue;
    out.push({
      src: r.src as string,
      dst: r.dst as string,
      score: window === "same-day" ? 1.0 : 0.5,
      reason: `temporal-proximity:${window}`,
    });
  }
  return out;
}

/** Tag overlap between live nodes; score scales with the overlap count. */
function sharedTagCandidates(db: Db): Candidate[] {
  return db
    .all(
      `SELECT t1.node_id AS src, t2.node_id AS dst,
              COUNT(*) AS overlap, MIN(t1.tag) AS tag
       FROM tags t1
       JOIN tags t2 ON t2.tag = t1.tag AND t1.node_id < t2.node_id
       JOIN nodes a ON a.id = t1.node_id AND a.deleted_at IS NULL
       JOIN nodes b ON b.id = t2.node_id AND b.deleted_at IS NULL
       GROUP BY t1.node_id, t2.node_id
       ORDER BY t1.node_id, t2.node_id`
    )
    .map((r) => ({
      src: r.src as string,
      dst: r.dst as string,
      score: Math.min(1.0, 0.4 * (r.overlap as number)),
      reason: `shared-tags:${r.tag as string}`,
    }));
}

/**
 * FTS more-like-this (SPEC §5.1): a node's title terms as the query. A
 * pair becomes a candidate when ≥ 2 distinct terms land — one shared
 * common word is not similarity. Chunks are excluded: sibling titles are
 * mechanically near-identical, and their `part_of` edges already bind
 * the family.
 */
function ftsSimilarityCandidates(db: Db): Candidate[] {
  const nodes = db.all(
    `SELECT id, title FROM nodes
     WHERE deleted_at IS NULL AND kind != 'chunk' ORDER BY id`
  );
  const termsByPair = new Map<string, Set<string>>();
  for (const n of nodes) {
    const terms = new Set(
      ((n.title as string).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(
        0,
        12
      )
    );
    for (const term of terms) {
      const matches = db.all(
        `SELECT n2.id FROM nodes_fts
         JOIN nodes n2 ON n2.id = nodes_fts.node_id
         WHERE nodes_fts MATCH ? AND n2.id != ?
           AND n2.deleted_at IS NULL AND n2.kind != 'chunk'`,
        `"${term}"`,
        n.id
      );
      for (const m of matches) {
        const [src, dst] =
          (n.id as string) < (m.id as string) ? [n.id, m.id] : [m.id, n.id];
        const key = `${src}|${dst}`;
        if (!termsByPair.has(key)) termsByPair.set(key, new Set());
        termsByPair.get(key)!.add(term);
      }
    }
  }
  return [...termsByPair]
    .filter(([, terms]) => terms.size >= 2)
    .map(([key, terms]) => {
      const [src, dst] = key.split("|") as [string, string];
      return {
        src,
        dst,
        score: Math.min(1.0, 0.25 * terms.size),
        reason: "fts-similarity",
      };
    });
}

/** Pairs already connected by any edge (either direction) are not candidates. */
function hasEdge(db: Db, a: string, b: string): boolean {
  return (
    db.get(
      `SELECT 1 AS x FROM edges
       WHERE (src = ? AND dst = ?) OR (src = ? AND dst = ?)`,
      a,
      b,
      b,
      a
    ) !== undefined
  );
}

export function suggestCommand(
  db: Db,
  ctx: Context,
  config: Config,
  limit?: number
): unknown {
  const windows = config.get("suggest.windows") as string[];
  const candidates = [
    ...temporalCandidates(db, windows),
    ...sharedTagCandidates(db),
    ...ftsSimilarityCandidates(db),
  ];

  candidates.sort((a, b) => b.score - a.score);
  const now = ctx.clock().toISOString();
  let created = 0;
  for (const c of candidates) {
    if (limit !== undefined && created >= limit) break;
    if (hasEdge(db, c.src, c.dst)) continue;
    const existing = db.get(
      "SELECT 1 AS x FROM link_suggestions WHERE src = ? AND dst = ?",
      c.src,
      c.dst
    );
    if (existing) continue; // pending stays, accepted done, rejected never again
    db.run(
      `INSERT INTO link_suggestions (src, dst, score, reason, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      c.src,
      c.dst,
      c.score,
      c.reason,
      now
    );
    created++;
  }

  const pending = db.get(
    "SELECT COUNT(*) AS n FROM link_suggestions WHERE status = 'pending'"
  )!.n as number;
  return { created, pending };
}

export function suggestReviewCommand(db: Db, limit?: number): unknown {
  return db.all(
    `SELECT src, dst, score, reason, created_at FROM link_suggestions
     WHERE status = 'pending'
     ORDER BY score DESC, src, dst
     LIMIT ?`,
    limit ?? -1
  );
}

/** Suggestions are direction-free: the stored row is canonical src < dst. */
function loadSuggestion(db: Db, a: string, b: string) {
  const [src, dst] = a < b ? [a, b] : [b, a];
  const row = db.get(
    "SELECT * FROM link_suggestions WHERE src = ? AND dst = ?",
    src,
    dst
  );
  if (!row) {
    throw new UserError("NOT_FOUND", `no suggestion for pair ${src} / ${dst}`);
  }
  return { src, dst };
}

export function suggestAcceptCommand(
  db: Db,
  ctx: Context,
  a: string,
  b: string
): unknown {
  const { src, dst } = loadSuggestion(db, a, b);
  db.exec("BEGIN");
  try {
    // an edge that appeared since the suggestion keeps its origin (silent
    // no-op, same rule as wikilinks — SPEC §5.1)
    let edge = db.get(
      `SELECT src, dst, rel, weight, origin FROM edges
       WHERE src = ? AND dst = ? AND rel = 'relates_to'`,
      src,
      dst
    );
    if (!edge) {
      edge = createEdge(db, ctx, {
        src,
        dst,
        rel: "relates_to",
        weight: 1.0,
        origin: "suggested",
      }) as Record<string, unknown>;
    }
    db.run(
      "UPDATE link_suggestions SET status = 'accepted' WHERE src = ? AND dst = ?",
      src,
      dst
    );
    db.exec("COMMIT");
    return { src, dst, status: "accepted", edge };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function suggestRejectCommand(db: Db, a: string, b: string): unknown {
  const { src, dst } = loadSuggestion(db, a, b);
  db.run(
    "UPDATE link_suggestions SET status = 'rejected' WHERE src = ? AND dst = ?",
    src,
    dst
  );
  return { src, dst, status: "rejected" };
}
