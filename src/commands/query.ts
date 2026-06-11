import type { Config } from "../config";
import type { Context } from "../context";
import { KINDS } from "../kinds";
import type { Db } from "../sqlite";

export type QueryArgs = {
  text?: string;
  kinds: string[];
  tags: string[];
  status?: string;
  since?: string;
  until?: string;
  limit?: number;
  hops?: number;
  includeClosed?: boolean;
};

export type QueryHit = {
  id: string;
  kind: string;
  title: string;
  snippet: string | null;
  score: number | null;
  hops: number;
  via: string[] | null;
};

/** Terminal states per SPEC §5.2; excluded from results unless --include-closed. */
function terminalExclusionSql(): string {
  const clauses: string[] = [];
  for (const [kind, def] of Object.entries(KINDS)) {
    if (!def.terminalStatuses) continue;
    const list = def.terminalStatuses.map((s) => `'${s}'`).join(", ");
    clauses.push(`NOT (n.kind = '${kind}' AND n.status IN (${list}))`);
  }
  return clauses.join(" AND ");
}

/** User-composable filters (SPEC §5.2 step 4) — applied to final results. */
function userFilterSql(args: QueryArgs, params: unknown[]): string[] {
  const where: string[] = [];
  if (args.kinds.length > 0) {
    where.push(`n.kind IN (${args.kinds.map(() => "?").join(", ")})`);
    params.push(...args.kinds);
  }
  for (const tag of args.tags) {
    where.push(
      "EXISTS (SELECT 1 FROM tags t WHERE t.node_id = n.id AND t.tag = ?)"
    );
    params.push(tag);
  }
  if (args.status !== undefined) {
    where.push("n.status = ?");
    params.push(args.status);
  }
  if (args.since !== undefined) {
    where.push("COALESCE(n.occurred_at, n.created_at) >= ?");
    params.push(args.since);
  }
  if (args.until !== undefined) {
    where.push("COALESCE(n.occurred_at, n.created_at) <= ?");
    params.push(args.until);
  }
  return where;
}

/** 30-day half-life over occurred_at falling back to created_at. */
export function recencyDecay(
  now: number,
  occurredAt: unknown,
  createdAt: unknown
) {
  const ts = Date.parse((occurredAt ?? createdAt) as string);
  const ageDays = Math.max(0, (now - ts) / 86_400_000);
  return Math.pow(2, -ageDays / 30);
}

export type Visit = { hops: number; via: string[]; pathWeight: number };

/**
 * Undirected BFS over edges from the seeds, ≤ maxHops (SPEC §5.2 step 2).
 * Soft-deleted nodes block traversal entirely; terminal-state nodes are
 * traversable intermediates (result-level exclusion happens later, so
 * `via` may name a closed node). First reach wins: min hops, seed order,
 * then edge insertion order.
 */
export function expandFromSeeds(
  db: Db,
  seedIds: string[],
  maxHops: number
): Map<string, Visit> {
  const visited = new Map<string, Visit>();
  for (const id of seedIds) {
    visited.set(id, { hops: 0, via: [], pathWeight: 1 });
  }
  let frontier = seedIds;
  for (let level = 1; level <= maxHops && frontier.length > 0; level++) {
    const marks = frontier.map(() => "?").join(", ");
    const edges = db.all(
      `SELECT e.src, e.dst, e.rel, e.weight FROM edges e
       JOIN nodes ns ON ns.id = e.src
       JOIN nodes nd ON nd.id = e.dst
       WHERE (e.src IN (${marks}) OR e.dst IN (${marks}))
         AND ns.deleted_at IS NULL AND nd.deleted_at IS NULL
       ORDER BY e.rowid`,
      ...frontier,
      ...frontier
    );
    const next: string[] = [];
    const inFrontier = new Set(frontier);
    for (const e of edges) {
      const src = e.src as string;
      const dst = e.dst as string;
      for (const [from, to] of [
        [src, dst],
        [dst, src],
      ] as const) {
        if (!inFrontier.has(from) || visited.has(to)) continue;
        const prev = visited.get(from)!;
        visited.set(to, {
          hops: level,
          via: [...prev.via, `${src} -${e.rel}-> ${dst}`],
          pathWeight: prev.pathWeight * (e.weight as number),
        });
        next.push(to);
      }
    }
    frontier = next;
  }
  return visited;
}

export function queryCommand(
  db: Db,
  ctx: Context,
  config: Config,
  args: QueryArgs
): QueryHit[] {
  const limit = args.limit ?? (config.get("query.default_limit") as number);

  if (args.text !== undefined && args.text !== "") {
    const w1 = config.get("query.weights.fts") as number;
    const w2 = config.get("query.weights.edge") as number;
    const w3 = config.get("query.weights.recency") as number;
    const hopDecay = config.get("query.hop_decay") as number;
    const maxHops = args.hops ?? 1;
    const now = ctx.clock().getTime();

    // 1. FTS seeds — BM25 weighted title > tags > body (column order:
    // node_id, title, body, tags). Soft-delete and terminal exclusion
    // apply to seeding; user filters compose on final results instead,
    // so expansion can cross kinds/tags the filters would keep.
    const seedWhere = args.includeClosed
      ? "n.deleted_at IS NULL"
      : `n.deleted_at IS NULL AND ${terminalExclusionSql()}`;
    const seeds = db.all(
      `SELECT n.id, n.kind, n.title, n.occurred_at, n.created_at,
              snippet(nodes_fts, -1, '<b>', '</b>', '…', 12) AS snip,
              -bm25(nodes_fts, 0.0, 10.0, 1.0, 5.0) AS score
       FROM nodes_fts
       JOIN nodes n ON n.id = nodes_fts.node_id
       WHERE nodes_fts MATCH ? AND ${seedWhere}
       ORDER BY bm25(nodes_fts, 0.0, 10.0, 1.0, 5.0)`,
      args.text
    );
    const maxBm25 = (seeds[0]?.score as number) || 1;
    const hits: QueryHit[] = seeds.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      title: r.title as string,
      snippet: r.snip as string,
      score:
        ((r.score as number) / maxBm25) * w1 +
        recencyDecay(now, r.occurred_at, r.created_at) * w3,
      hops: 0,
      via: null,
    }));

    // 2. expansion (SPEC §5.2 steps 2–3)
    const visited = expandFromSeeds(
      db,
      hits.map((h) => h.id),
      maxHops
    );
    const expandedIds = [...visited.entries()]
      .filter(([, v]) => v.hops > 0)
      .map(([id]) => id);
    if (expandedIds.length > 0) {
      const marks = expandedIds.map(() => "?").join(", ");
      const rows = db.all(
        `SELECT n.id, n.kind, n.title, n.occurred_at, n.created_at
         FROM nodes n WHERE n.id IN (${marks}) AND ${seedWhere}`,
        ...expandedIds
      );
      for (const r of rows) {
        const v = visited.get(r.id as string)!;
        hits.push({
          id: r.id as string,
          kind: r.kind as string,
          title: r.title as string,
          snippet: null,
          score:
            v.pathWeight * w2 * Math.pow(hopDecay, v.hops) +
            recencyDecay(now, r.occurred_at, r.created_at) * w3,
          hops: v.hops,
          via: v.via,
        });
      }
    }

    // 4. user filters compose on the combined result set
    const filtered = applyUserFilters(db, hits, args);
    filtered.sort((a, b) => (b.score as number) - (a.score as number));
    return dedupChunks(db, filtered).slice(0, limit);
  }

  // Listing mode (SPEC §5.2): no text = pure filtered listing, recency order
  const params: unknown[] = [];
  const where = [
    "n.deleted_at IS NULL",
    ...(args.includeClosed ? [] : [terminalExclusionSql()]),
    ...userFilterSql(args, params),
  ].join(" AND ");
  params.push(limit);
  const rows = db.all(
    `SELECT n.id, n.kind, n.title
     FROM nodes n
     WHERE ${where}
     ORDER BY COALESCE(n.occurred_at, n.created_at) DESC
     LIMIT ?`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    title: r.title as string,
    snippet: null,
    score: null,
    hops: 0,
    via: null,
  }));
}

function applyUserFilters(
  db: Db,
  hits: QueryHit[],
  args: QueryArgs
): QueryHit[] {
  const params: unknown[] = [];
  const where = userFilterSql(args, params);
  if (where.length === 0 || hits.length === 0) return hits;
  const marks = hits.map(() => "?").join(", ");
  const passing = new Set(
    db
      .all(
        `SELECT n.id FROM nodes n
         WHERE n.id IN (${marks}) AND ${where.join(" AND ")}`,
        ...hits.map((h) => h.id),
        ...params
      )
      .map((r) => r.id as string)
  );
  return hits.filter((h) => passing.has(h.id));
}

/**
 * Chunk dedup (SPEC §5.2 step 5): one result per document. An FTS-matched
 * chunk (hops 0) beats its source and siblings; chunks dragged in only by
 * expansion never outrank their family — the source stays when it is the
 * real match. Hits arrive score-descending.
 */
function dedupChunks(db: Db, hits: QueryHit[]): QueryHit[] {
  const chunkIds = hits.filter((h) => h.kind === "chunk").map((h) => h.id);
  if (chunkIds.length === 0) return hits;

  const parentOf = new Map<string, string>();
  for (const row of db.all(
    `SELECT src, dst FROM edges WHERE rel = 'part_of' AND src IN (${chunkIds.map(() => "?").join(", ")})`,
    ...chunkIds
  )) {
    parentOf.set(row.src as string, row.dst as string);
  }

  const hitIds = new Set(hits.map((h) => h.id));
  const matchedParents = new Set(
    hits
      .filter((h) => h.kind === "chunk" && h.hops === 0)
      .map((h) => parentOf.get(h.id))
      .filter((p): p is string => p !== undefined)
  );
  const seenParent = new Set<string>();
  return hits.filter((h) => {
    if (h.kind === "chunk") {
      const parent = parentOf.get(h.id);
      if (parent === undefined) return true;
      if (matchedParents.has(parent)) {
        // family has a real FTS match: keep the best matched chunk only
        if (h.hops !== 0 || seenParent.has(parent)) return false;
        seenParent.add(parent);
        return true;
      }
      // dragged in by expansion only: the source row represents the document
      return !hitIds.has(parent);
    }
    return !matchedParents.has(h.id); // drop the source when chunks matched
  });
}

/** `--human`: markdown list (SPEC §10.3). */
export function renderHuman(hits: QueryHit[]): string {
  if (hits.length === 0) return "_no results_";
  return hits
    .map((h) => {
      const snippet = h.snippet ? ` — ${h.snippet}` : "";
      return `- **${h.title}** (${h.kind}, \`${h.id}\`)${snippet}`;
    })
    .join("\n");
}
