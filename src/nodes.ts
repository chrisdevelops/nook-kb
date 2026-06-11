import { UserError } from "./errors";
import type { Db } from "./sqlite";

export type NodeRow = Record<string, unknown>;

/** Any id not present in nodes is NOT_FOUND (ids are opaque, SPEC §2). */
export function loadNode(db: Db, id: string): NodeRow {
  const row = db.get("SELECT * FROM nodes WHERE id = ?", id);
  if (!row) throw new UserError("NOT_FOUND", `no node "${id}"`);
  return row;
}

/** Mutations require a live node: deleted = gone except get/restore (SPEC §3.1). */
export function loadLiveNode(db: Db, id: string): NodeRow {
  const row = loadNode(db, id);
  if (row.deleted_at !== null) {
    throw new UserError("NOT_FOUND", `node "${id}" is deleted`);
  }
  return row;
}

export function nodeTags(db: Db, id: string): string[] {
  return db
    .all("SELECT tag FROM tags WHERE node_id = ? ORDER BY rowid", id)
    .map((r) => r.tag as string);
}

/** Canonical node object (TDD §2.2). */
export function nodeResponse(
  row: NodeRow,
  tags: string[]
): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body_length: (row.body as string).length,
    payload: JSON.parse(row.payload as string),
    status: row.status,
    tags,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}
