import { ftsUpsert } from "../fts";
import { loadLiveNode, nodeTags } from "../nodes";
import type { Db } from "../sqlite";

function resync(db: Db, id: string): string[] {
  const row = loadLiveNode(db, id);
  const tags = nodeTags(db, id);
  ftsUpsert(
    db,
    { id, title: row.title as string, body: row.body as string },
    tags
  );
  return tags;
}

export function tagCommand(db: Db, id: string, tags: string[]): unknown {
  loadLiveNode(db, id);
  db.exec("BEGIN");
  try {
    for (const tag of tags) {
      // idempotent: re-tagging is a no-op success (T7.4)
      db.run(
        "INSERT OR IGNORE INTO tags (node_id, tag) VALUES (?, ?)",
        id,
        tag
      );
    }
    const all = resync(db, id);
    db.exec("COMMIT");
    return { id, tags: all };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function untagCommand(db: Db, id: string, tags: string[]): unknown {
  loadLiveNode(db, id);
  db.exec("BEGIN");
  try {
    for (const tag of tags) {
      db.run("DELETE FROM tags WHERE node_id = ? AND tag = ?", id, tag);
    }
    const all = resync(db, id);
    db.exec("COMMIT");
    return { id, tags: all };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
