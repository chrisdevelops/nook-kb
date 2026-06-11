import type { Db } from "./sqlite";

/** Contentful nodes_fts write-through (SPEC §3.1): one row per node. */
export function ftsUpsert(
  db: Db,
  node: { id: string; title: string; body: string },
  tags: string[]
): void {
  db.run("DELETE FROM nodes_fts WHERE node_id = ?", node.id);
  db.run(
    "INSERT INTO nodes_fts (node_id, title, body, tags) VALUES (?, ?, ?, ?)",
    node.id,
    node.title,
    node.body,
    tags.join(" ")
  );
}
