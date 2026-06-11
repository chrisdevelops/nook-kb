import { chunkTranscript } from "../chunker";
import type { Config } from "../config";
import type { Context } from "../context";
import { createEdge } from "../edges";
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
  links: { dst: string; rel: string }[];
  status?: string;
  occurredAt?: string;
};

/**
 * Auto-chunk a long source (SPEC §4.1): chunk nodes titled
 * "<source title> (n/total)", part_of edges back, source keeps full body.
 */
function chunkSource(
  db: Db,
  ctx: Context,
  source: { id: string; title: string; body: string },
  budget: number
): number {
  const pieces = chunkTranscript(source.body, budget);
  if (pieces.length <= 1) return 0;
  for (const piece of pieces) {
    const chunkId = ctx.generateId();
    const now = ctx.clock().toISOString();
    const title = `${source.title} (${piece.position}/${pieces.length})`;
    db.run(
      `INSERT INTO nodes (id, kind, title, body, payload, status, occurred_at, created_at, updated_at)
       VALUES (?, 'chunk', ?, ?, ?, NULL, NULL, ?, ?)`,
      chunkId,
      title,
      piece.text,
      JSON.stringify({ position: piece.position }),
      now,
      now
    );
    createEdge(db, ctx, {
      src: chunkId,
      dst: source.id,
      rel: "part_of",
      origin: "direct",
    });
    ftsUpsert(db, { id: chunkId, title, body: piece.text }, []);
  }
  return pieces.length;
}

export function addCommand(
  db: Db,
  ctx: Context,
  config: Config,
  args: AddArgs
): unknown {
  const def = KINDS[args.kind];
  if (!def) throw new UserError("UNKNOWN_KIND", `unknown kind "${args.kind}"`);

  if (args.status !== undefined) validateStatus(args.kind, args.status);
  const status = args.status ?? def.defaultStatus;

  const payloadValue = parsePayload(args.payload);
  validatePayload(args.kind, payloadValue);

  // Event invariant (SPEC §3.1): occurred_at = starts_at, no second knob
  let occurredAt = args.occurredAt ?? null;
  if (args.kind === "event") {
    if (args.occurredAt !== undefined) {
      throw new UserError(
        "INVALID_ARGS",
        "events derive occurred_at from starts_at; --occurred-at is not allowed"
      );
    }
    occurredAt = (payloadValue as { starts_at: string }).starts_at;
  }

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
      occurredAt,
      now,
      now
    );
    for (const tag of args.tags) {
      db.run("INSERT INTO tags (node_id, tag) VALUES (?, ?)", id, tag);
    }
    // links inside the same transaction: a bad link aborts the whole add (T5.6)
    const linksCreated = args.links.map((l) => {
      createEdge(db, ctx, {
        src: id,
        dst: l.dst,
        rel: l.rel,
        origin: "direct",
      });
      return { dst: l.dst, rel: l.rel };
    });
    ftsUpsert(db, { id, title: args.title, body }, args.tags);
    const chunksCreated =
      args.kind === "source"
        ? chunkSource(
            db,
            ctx,
            { id, title: args.title, body },
            config.get("chunk.budget_tokens") as number
          )
        : 0;
    db.exec("COMMIT");

    const row = db.get("SELECT * FROM nodes WHERE id = ?", id)!;
    return {
      ...nodeResponse(row, args.tags),
      links_created: linksCreated,
      chunks_created: chunksCreated,
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
