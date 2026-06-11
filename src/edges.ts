import type { Context } from "./context";
import { UserError } from "./errors";
import { loadLiveNode } from "./nodes";
import { RELATIONS } from "./relations";
import type { Db } from "./sqlite";

export type EdgeSpec = {
  src: string;
  dst: string;
  rel: string;
  weight?: number;
  origin: "direct" | "wikilink" | "suggested";
};

/**
 * Shared edge creation for add --link, mem link, wikilink, and suggest
 * channels. Validates rel and endpoints, canonicalizes symmetric pairs.
 * A duplicate (same src/dst/rel) throws DUPLICATE_EDGE by default;
 * `ifDuplicate: "keep"` makes it the SPEC §5.1 silent no-op instead —
 * the existing row (and its origin) is returned with `existed: true`,
 * atomically via INSERT OR IGNORE so concurrent writers cannot race the
 * check. Caller owns the transaction.
 */
export function createEdge(
  db: Db,
  ctx: Context,
  spec: EdgeSpec,
  opts?: { ifDuplicate?: "error" | "keep" }
): EdgeSpec & { existed?: true } {
  const relDef = RELATIONS[spec.rel];
  if (!relDef) {
    throw new UserError("UNKNOWN_REL", `unknown relation "${spec.rel}"`);
  }
  loadLiveNode(db, spec.src);
  loadLiveNode(db, spec.dst);

  let { src, dst } = spec;
  if (relDef.symmetric && dst < src) [src, dst] = [dst, src];

  const weight = spec.weight ?? 1.0;
  db.run(
    "INSERT OR IGNORE INTO edges (src, dst, rel, weight, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    src,
    dst,
    spec.rel,
    weight,
    spec.origin,
    ctx.clock().toISOString()
  );
  if ((db.get("SELECT changes() AS n")!.n as number) === 1) {
    return { src, dst, rel: spec.rel, weight, origin: spec.origin };
  }
  if (opts?.ifDuplicate !== "keep") {
    throw new UserError(
      "DUPLICATE_EDGE",
      `edge ${src} -[${spec.rel}]-> ${dst} already exists`
    );
  }
  const row = db.get(
    "SELECT src, dst, rel, weight, origin FROM edges WHERE src = ? AND dst = ? AND rel = ?",
    src,
    dst,
    spec.rel
  )!;
  return {
    src: row.src as string,
    dst: row.dst as string,
    rel: row.rel as string,
    weight: row.weight as number,
    origin: row.origin as EdgeSpec["origin"],
    existed: true,
  };
}

/** `--link <id>:<rel>` flag syntax. */
export function parseLinkFlag(raw: string): { dst: string; rel: string } {
  const sep = raw.lastIndexOf(":");
  if (sep <= 0 || sep === raw.length - 1) {
    throw new UserError(
      "INVALID_ARGS",
      `--link expects <id>:<rel>, got "${raw}"`
    );
  }
  return { dst: raw.slice(0, sep), rel: raw.slice(sep + 1) };
}
