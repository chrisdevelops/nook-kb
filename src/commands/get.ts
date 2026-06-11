import { loadNode, nodeResponse, nodeTags } from "../nodes";
import type { Db } from "../sqlite";

export function getCommand(
  db: Db,
  id: string,
  opts: { withEdges?: boolean; withBody?: boolean }
): unknown {
  const row = loadNode(db, id); // soft-deleted stays readable (T6.3)
  const res: Record<string, unknown> = nodeResponse(row, nodeTags(db, id));
  if (opts.withBody) res.body = row.body;
  if (opts.withEdges) {
    res.edges = {
      out: db.all(
        "SELECT dst, rel, weight, origin, created_at FROM edges WHERE src = ? ORDER BY rowid",
        id
      ),
      in: db.all(
        "SELECT src, rel, weight, origin, created_at FROM edges WHERE dst = ? ORDER BY rowid",
        id
      ),
    };
  }
  return res;
}
