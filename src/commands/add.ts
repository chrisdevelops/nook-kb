import type { Context } from "../context";
import { UserError } from "../errors";
import { ftsUpsert } from "../fts";
import { KINDS } from "../kinds";
import type { Db } from "../sqlite";
import { parsePayload, validatePayload } from "../validate";

export type AddArgs = {
  kind: string;
  title: string;
  body?: string;
  payload?: string;
  tags: string[];
  status?: string;
  occurredAt?: string;
};

/** Canonical node object (TDD §2.2) from a nodes row. */
export function nodeResponse(
  row: Record<string, unknown>,
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

export function addCommand(db: Db, ctx: Context, args: AddArgs): unknown {
  const def = KINDS[args.kind];
  if (!def) throw new UserError("UNKNOWN_KIND", `unknown kind "${args.kind}"`);

  if (args.status !== undefined) {
    if (def.statuses === null) {
      throw new UserError(
        "INVALID_STATUS",
        `kind "${args.kind}" has no status vocabulary`
      );
    }
    if (!def.statuses.includes(args.status)) {
      throw new UserError(
        "INVALID_STATUS",
        `invalid status "${args.status}" for kind "${args.kind}" (expected ${def.statuses.join("|")})`
      );
    }
  }
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
