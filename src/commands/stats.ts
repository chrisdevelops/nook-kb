import type { Db } from "../sqlite";

export function statsCommand(db: Db): unknown {
  // kind counts cover live nodes; soft-deleted surface as one figure
  const nodes: Record<string, number> = {};
  for (const row of db.all(
    "SELECT kind, COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL GROUP BY kind"
  )) {
    nodes[row.kind as string] = row.n as number;
  }
  const count = (sql: string) => db.get(sql)?.n as number;
  return {
    nodes,
    edges: count("SELECT COUNT(*) AS n FROM edges"),
    tags: count("SELECT COUNT(*) AS n FROM tags"),
    suggestions_pending: count(
      "SELECT COUNT(*) AS n FROM link_suggestions WHERE status = 'pending'"
    ),
    deleted: count(
      "SELECT COUNT(*) AS n FROM nodes WHERE deleted_at IS NOT NULL"
    ),
  };
}
