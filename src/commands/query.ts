import type { Config } from "../config";
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
  includeClosed?: boolean;
};

export type QueryHit = {
  id: string;
  kind: string;
  title: string;
  snippet: string | null;
  score: number | null;
  hops: number;
  via: null;
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

function filterSql(args: QueryArgs, params: unknown[]): string {
  const where: string[] = ["n.deleted_at IS NULL"];
  if (!args.includeClosed) where.push(terminalExclusionSql());
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
  return where.join(" AND ");
}

export function queryCommand(
  db: Db,
  config: Config,
  args: QueryArgs
): QueryHit[] {
  const limit = args.limit ?? (config.get("query.default_limit") as number);

  if (args.text !== undefined && args.text !== "") {
    // FTS mode: BM25 weighted title > tags > body (column order:
    // node_id, title, body, tags). No SQL LIMIT — chunk dedup happens
    // below, then the limit applies to the deduped list.
    const params: unknown[] = [args.text];
    const where = filterSql(args, params);
    const rows = db.all(
      `SELECT n.id, n.kind, n.title,
              snippet(nodes_fts, -1, '<b>', '</b>', '…', 12) AS snip,
              -bm25(nodes_fts, 0.0, 10.0, 1.0, 5.0) AS score
       FROM nodes_fts
       JOIN nodes n ON n.id = nodes_fts.node_id
       WHERE nodes_fts MATCH ? AND ${where}
       ORDER BY bm25(nodes_fts, 0.0, 10.0, 1.0, 5.0)`,
      ...params
    );
    const hits = rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      title: r.title as string,
      snippet: r.snip as string,
      score: r.score as number,
      hops: 0,
      via: null,
    }));
    return dedupChunks(db, hits).slice(0, limit);
  }

  // Listing mode (SPEC §5.2): no text = pure filtered listing, recency order
  const params: unknown[] = [];
  const where = filterSql(args, params);
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

/**
 * Chunk dedup (SPEC §5.2): when a chunked source and its chunks both
 * match, drop the source row and all but the highest-scoring chunk —
 * one result per document. Hits arrive score-descending.
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

  const matchedParents = new Set(parentOf.values());
  const seenParent = new Set<string>();
  return hits.filter((h) => {
    if (h.kind === "chunk") {
      const parent = parentOf.get(h.id);
      if (parent === undefined) return true;
      if (seenParent.has(parent)) return false; // keep best chunk only
      seenParent.add(parent);
      return true;
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
