import type { Context } from "./context";
import { createEdge } from "./edges";
import type { Db } from "./sqlite";

export type WikilinkResolution = {
  edges: { dst: string }[];
  unresolved: string[];
};

const WIKILINK = /\[\[([^[\]\n]+)\]\]/g;

/**
 * Resolve body wikilinks to edge targets (SPEC §5.1): `[[<id>]]` or
 * `[[Exact Title]]` against live nodes. Pure-function seam like the
 * chunker — persistence and diffing live with the callers.
 */
export function resolveWikilinks(body: string, db: Db): WikilinkResolution {
  const edges: { dst: string }[] = [];
  const unresolved: string[] = [];
  for (const match of body.matchAll(WIKILINK)) {
    const target = match[1]!;
    const byId = db.get(
      "SELECT id FROM nodes WHERE id = ? AND deleted_at IS NULL",
      target
    );
    if (byId) {
      edges.push({ dst: byId.id as string });
      continue;
    }
    const byTitle = db.all(
      "SELECT id FROM nodes WHERE title = ? COLLATE NOCASE AND deleted_at IS NULL",
      target
    );
    if (byTitle.length === 1) {
      edges.push({ dst: byTitle[0]!.id as string });
    } else {
      unresolved.push(target); // zero or many: never guess (SPEC §5.1)
    }
  }
  return { edges, unresolved };
}

/**
 * Persist a body's wikilinks for `src` (SPEC §5.1): resolved links become
 * `references` edges with origin `wikilink`; a link duplicating an existing
 * edge (same src/dst/rel) is a silent no-op keeping the existing origin.
 * The diff is origin-scoped — vanished links remove `wikilink` edges only;
 * `direct`/`suggested` edges are never touched. Unresolved links are
 * returned, never persisted. Caller owns the transaction.
 */
export function applyWikilinks(
  db: Db,
  ctx: Context,
  src: string,
  body: string
): { created: { dst: string; rel: string }[]; unresolved: string[] } {
  const { edges, unresolved } = resolveWikilinks(body, db);
  // a body naming its own node is not a relationship — drop silently
  const wanted = new Set(edges.map((e) => e.dst).filter((dst) => dst !== src));
  db.run(
    `DELETE FROM edges WHERE src = ? AND rel = 'references' AND origin = 'wikilink'
     AND dst NOT IN (SELECT value FROM json_each(?))`,
    src,
    JSON.stringify([...wanted])
  );
  const created: { dst: string; rel: string }[] = [];
  for (const dst of wanted) {
    const edge = createEdge(
      db,
      ctx,
      { src, dst, rel: "references", origin: "wikilink" },
      { ifDuplicate: "keep" }
    );
    if (!edge.existed) created.push({ dst, rel: "references" });
  }
  return { created, unresolved };
}
