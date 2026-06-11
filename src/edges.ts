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
 * Shared edge creation for add --link, mem link, and (later) wikilink/
 * suggest channels. Validates rel and endpoints, canonicalizes symmetric
 * pairs, rejects duplicates. Caller owns the transaction.
 */
export function createEdge(db: Db, ctx: Context, spec: EdgeSpec): EdgeSpec {
  const relDef = RELATIONS[spec.rel];
  if (!relDef) {
    throw new UserError("UNKNOWN_REL", `unknown relation "${spec.rel}"`);
  }
  loadLiveNode(db, spec.src);
  loadLiveNode(db, spec.dst);

  let { src, dst } = spec;
  if (relDef.symmetric && dst < src) [src, dst] = [dst, src];

  const exists = db.get(
    "SELECT 1 AS x FROM edges WHERE src = ? AND dst = ? AND rel = ?",
    src,
    dst,
    spec.rel
  );
  if (exists) {
    throw new UserError(
      "DUPLICATE_EDGE",
      `edge ${src} -[${spec.rel}]-> ${dst} already exists`
    );
  }

  const weight = spec.weight ?? 1.0;
  db.run(
    "INSERT INTO edges (src, dst, rel, weight, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    src,
    dst,
    spec.rel,
    weight,
    spec.origin,
    ctx.clock().toISOString()
  );
  return { src, dst, rel: spec.rel, weight, origin: spec.origin };
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
