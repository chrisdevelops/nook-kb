import type { Config } from "../config";
import type { Context } from "../context";
import { loadLiveNode } from "../nodes";
import type { Db } from "../sqlite";
import { expandFromSeeds, graphWeights, pathScore } from "./query";

export type RelatedArgs = {
  hops?: number;
  limit?: number;
};

export type RelatedItem = {
  id: string;
  kind: string;
  title: string;
  hops: number | null; // null = tag-implied, not an edge hop
  via: string[];
};

/**
 * Pure graph neighborhood (SPEC §5.2): ranked neighbors at ≤ --hops, no
 * FTS. Closed nodes stay fully visible here; soft-deleted nodes block
 * traversal. Ranking is edge-path weight with hop decay plus recency —
 * asserted by ordering only, never values.
 */
export function relatedCommand(
  db: Db,
  ctx: Context,
  config: Config,
  id: string,
  args: RelatedArgs
): RelatedItem[] {
  loadLiveNode(db, id);
  const maxHops = args.hops ?? 1;
  const limit = args.limit ?? (config.get("query.default_limit") as number);
  const weights = graphWeights(config);
  const now = ctx.clock().getTime();

  const visited = expandFromSeeds(db, [id], maxHops);
  visited.delete(id);

  let ranked: RelatedItem[] = [];
  if (visited.size > 0) {
    const marks = [...visited.keys()].map(() => "?").join(", ");
    const rows = db.all(
      `SELECT n.id, n.kind, n.title, n.occurred_at, n.created_at
       FROM nodes n WHERE n.id IN (${marks}) AND n.deleted_at IS NULL`,
      ...visited.keys()
    );
    ranked = rows
      .map((r) => {
        const v = visited.get(r.id as string)!;
        return {
          item: {
            id: r.id as string,
            kind: r.kind as string,
            title: r.title as string,
            hops: v.hops as number | null,
            via: v.via,
          },
          score: pathScore(v, now, r.occurred_at, r.created_at, weights),
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item);
  }

  // shared-tag nodes append as weak implicit relations (SPEC §5.2)
  const seen = new Set([id, ...ranked.map((r) => r.id)]);
  const weak = db
    .all(
      `SELECT n.id, n.kind, n.title, MIN(t2.tag) AS tag
       FROM tags t1
       JOIN tags t2 ON t2.tag = t1.tag AND t2.node_id != t1.node_id
       JOIN nodes n ON n.id = t2.node_id
       WHERE t1.node_id = ? AND n.deleted_at IS NULL
       GROUP BY n.id, n.kind, n.title
       ORDER BY MIN(t2.rowid)`,
      id
    )
    .filter((r) => !seen.has(r.id as string))
    .map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      title: r.title as string,
      hops: null,
      via: [`shared-tag:${r.tag as string}`],
    }));

  return [...ranked, ...weak].slice(0, limit);
}
