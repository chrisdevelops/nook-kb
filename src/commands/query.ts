import type { Db } from "../sqlite";

/**
 * Minimal FTS-only query (Phase 1, --hops 0): BM25 weighted
 * title > tags > body over the contentful index; soft-deleted excluded.
 * Column weight order matches nodes_fts (node_id, title, body, tags).
 */
export function queryCommand(db: Db, text: string): unknown {
  const rows = db.all(
    `SELECT n.id, n.kind, n.title,
            snippet(nodes_fts, -1, '<b>', '</b>', '…', 12) AS snip,
            -bm25(nodes_fts, 0.0, 10.0, 1.0, 5.0) AS score
     FROM nodes_fts
     JOIN nodes n ON n.id = nodes_fts.node_id
     WHERE nodes_fts MATCH ?
       AND n.deleted_at IS NULL
     ORDER BY bm25(nodes_fts, 0.0, 10.0, 1.0, 5.0)`,
    text
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    snippet: r.snip,
    score: r.score,
    hops: 0,
    via: null,
  }));
}
