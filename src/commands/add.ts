import type { Context } from "../context";
import { UserError } from "../errors";
import { ftsUpsert } from "../fts";
import { KINDS } from "../kinds";
import { nodeResponse } from "../nodes";
import type { Db } from "../sqlite";
import { parsePayload, validatePayload, validateStatus } from "../validate";

export type AddArgs = {
  kind: string;
  title: string;
  body?: string;
  payload?: string;
  tags: string[];
  status?: string;
  occurredAt?: string;
};

export function addCommand(db: Db, ctx: Context, args: AddArgs): unknown {
  const def = KINDS[args.kind];
  if (!def) throw new UserError("UNKNOWN_KIND", `unknown kind "${args.kind}"`);

  if (args.status !== undefined) validateStatus(args.kind, args.status);
  const status = args.status ?? def.defaultStatus;

  const payloadValue = parsePayload(args.payload);
  validatePayload(args.kind, payloadValue);

  const id = ctx.generateId();
  const now = ctx.clock().toISOString();
  const body = args.body ?? "";
  const payload = JSON.stringify(payloadValue);

  db.exec("BEGIN");
  try {
    db.run(
      `INSERT INTO nodes (id, kind, title, body, payload, status, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      args.kind,
      args.title,
      body,
      payload,
      status,
      args.occurredAt ?? null,
      now,
      now
    );
    for (const tag of args.tags) {
      db.run("INSERT INTO tags (node_id, tag) VALUES (?, ?)", id, tag);
    }
    ftsUpsert(db, { id, title: args.title, body }, args.tags);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const row = db.get("SELECT * FROM nodes WHERE id = ?", id)!;
  return {
    ...nodeResponse(row, args.tags),
    links_created: [],
    chunks_created: 0,
  };
}
