import type { Context } from "../context";
import { createEdge } from "../edges";
import { UserError } from "../errors";
import { RELATIONS } from "../relations";
import type { Db } from "../sqlite";

export function linkCommand(
  db: Db,
  ctx: Context,
  src: string,
  dst: string,
  rel: string,
  weight: number | undefined
): unknown {
  db.exec("BEGIN");
  try {
    const edge = createEdge(db, ctx, {
      src,
      dst,
      rel,
      weight,
      origin: "direct",
    });
    db.exec("COMMIT");
    return edge;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function unlinkCommand(
  db: Db,
  src: string,
  dst: string,
  rel: string
): unknown {
  // symmetric rels are stored canonically; accept either argument order
  const symmetric = RELATIONS[rel]?.symmetric ?? false;
  const [s, d] = symmetric && dst < src ? [dst, src] : [src, dst];
  const exists = db.get(
    "SELECT 1 AS x FROM edges WHERE src = ? AND dst = ? AND rel = ?",
    s,
    d,
    rel
  );
  if (!exists) {
    throw new UserError("NOT_FOUND", `no edge ${src} -[${rel}]-> ${dst}`);
  }
  db.run("DELETE FROM edges WHERE src = ? AND dst = ? AND rel = ?", s, d, rel);
  return { src: s, dst: d, rel, removed: true };
}
