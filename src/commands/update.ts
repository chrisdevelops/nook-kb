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

  // Archival cascade (SPEC §4.1): project → archived drops its non-terminal
  // part_of tasks in the same operation, one hop only.
  const archiving =
    row.kind === "project" &&
    args.status === "archived" &&
    row.status !== "archived";

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

    let cascaded: { id: string; from: string; to: string }[] | undefined;
    if (archiving) {
      cascaded = db
        .all(
          `SELECT n.id, n.status FROM nodes n
           JOIN edges e ON e.src = n.id AND e.dst = ? AND e.rel = 'part_of'
           WHERE n.kind = 'task' AND n.deleted_at IS NULL
             AND n.status IN ('open', 'in_progress')
           ORDER BY n.id`,
          id
        )
        .map((t) => ({
          id: t.id as string,
          from: t.status as string,
          to: "dropped",
        }));
      for (const t of cascaded) {
        db.run(
          "UPDATE nodes SET status = 'dropped', updated_at = ? WHERE id = ?",
          now,
          t.id
        );
      }
    }
    db.exec("COMMIT");

    const updated = db.get("SELECT * FROM nodes WHERE id = ?", id)!;
    const res = nodeResponse(updated, nodeTags(db, id));
    return cascaded === undefined ? res : { ...res, cascaded };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
