import type { Context } from "../context";
import { UserError } from "../errors";
import { ftsUpsert } from "../fts";
import { KINDS } from "../kinds";
import { loadLiveNode, nodeResponse, nodeTags } from "../nodes";
import type { Db } from "../sqlite";
import { parsePayload, validatePayload, validateStatus } from "../validate";

export type UpdateArgs = {
  title?: string;
  body?: string;
  payloadMerge?: string;
  status?: string;
  occurredAt?: string;
};

/** RFC 7386 shallow merge: null deletes the key (SPEC §6). */
function mergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export function updateCommand(
  db: Db,
  ctx: Context,
  id: string,
  args: UpdateArgs
): unknown {
  const row = loadLiveNode(db, id);
  const def = KINDS[row.kind as string];
  // a stored kind missing from the registry is a system invariant breach
  if (!def) throw new Error(`unregistered kind "${row.kind}" in database`);

  if (args.status !== undefined) {
    validateStatus(row.kind as string, args.status);
  }

  let payload = row.payload as string;
  if (args.payloadMerge !== undefined) {
    const patch = parsePayload(args.payloadMerge);
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new UserError("INVALID_ARGS", "--payload-merge must be an object");
    }
    const merged = mergePatch(
      JSON.parse(payload),
      patch as Record<string, unknown>
    );
    validatePayload(row.kind as string, merged); // whole-schema revalidation (T6.5)
    payload = JSON.stringify(merged);
  }

  const title = args.title ?? (row.title as string);
  const body = args.body ?? (row.body as string);
  const now = ctx.clock().toISOString();

  db.exec("BEGIN");
  try {
    db.run(
      `UPDATE nodes SET title = ?, body = ?, payload = ?, status = ?, occurred_at = ?, updated_at = ?
       WHERE id = ?`,
      title,
      body,
      payload,
      args.status ?? (row.status as string | null),
      args.occurredAt ?? (row.occurred_at as string | null),
      now,
      id
    );
    ftsUpsert(db, { id, title, body }, nodeTags(db, id)); // T4.2 re-index
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const updated = db.get("SELECT * FROM nodes WHERE id = ?", id)!;
  return nodeResponse(updated, nodeTags(db, id));
}
