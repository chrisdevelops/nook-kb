import type { Config } from "../config";
import type { Context } from "../context";
import { ftsUpsert } from "../fts";
import { loadLiveNode, loadNode, nodeTags } from "../nodes";
import type { Db } from "../sqlite";

export function deleteCommand(db: Db, ctx: Context, id: string): unknown {
  loadLiveNode(db, id); // second delete is NOT_FOUND (T6.5c)
  const deletedAt = ctx.clock().toISOString();
  db.exec("BEGIN");
  try {
    db.run(
      "UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE id = ?",
      deletedAt,
      deletedAt,
      id
    );
    db.run("DELETE FROM nodes_fts WHERE node_id = ?", id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { id, deleted_at: deletedAt };
}

export function restoreCommand(db: Db, ctx: Context, id: string): unknown {
  const row = loadNode(db, id); // NOT_FOUND if purged or never existed
  if (row.deleted_at !== null) {
    const now = ctx.clock().toISOString();
    db.exec("BEGIN");
    try {
      db.run(
        "UPDATE nodes SET deleted_at = NULL, updated_at = ? WHERE id = ?",
        now,
        id
      );
      ftsUpsert(
        db,
        { id, title: row.title as string, body: row.body as string },
        nodeTags(db, id)
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  // restoring a live node is an idempotent no-op (matches T7.4 tag idempotency)
  return { id, deleted_at: null };
}

export function purgeCommand(
  db: Db,
  ctx: Context,
  config: Config,
  olderThan: number | undefined
): unknown {
  // flag > config > default (SPEC §2.1)
  const days = olderThan ?? (config.get("purge.default_days") as number);
  const cutoff = new Date(
    ctx.clock().getTime() - days * 86_400_000
  ).toISOString();

  db.exec("BEGIN");
  try {
    const doomed = db
      .all(
        "SELECT id FROM nodes WHERE deleted_at IS NOT NULL AND deleted_at <= ?",
        cutoff
      )
      .map((r) => r.id as string);
    for (const id of doomed) {
      db.run("DELETE FROM edges WHERE src = ? OR dst = ?", id, id);
      db.run("DELETE FROM tags WHERE node_id = ?", id);
      db.run("DELETE FROM link_suggestions WHERE src = ? OR dst = ?", id, id);
      db.run("DELETE FROM nodes_fts WHERE node_id = ?", id);
      db.run("DELETE FROM nodes WHERE id = ?", id);
    }
    db.exec("COMMIT");
    return { purged: doomed.length };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
