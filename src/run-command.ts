import { cac } from "cac";
import { addCommand } from "./commands/add";
import { getCommand } from "./commands/get";
import {
  deleteCommand,
  purgeCommand,
  restoreCommand,
} from "./commands/lifecycle";
import { updateCommand, type UpdateArgs } from "./commands/update";
import { kindsCommand } from "./commands/kinds";
import { linkCommand, unlinkCommand } from "./commands/link";
import { tagCommand, untagCommand } from "./commands/tag";
import { queryCommand } from "./commands/query";
import { statsCommand } from "./commands/stats";
import type { CommandResult, Context } from "./context";
import { ConfigError, loadConfig } from "./config";
import { parseLinkFlag } from "./edges";
import { UserError } from "./errors";
import { openStore } from "./store";
import type { Db } from "./sqlite";

/** CAC yields a scalar for one flag occurrence, an array for several. */
function many(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function errorJson(code: string, e: unknown): string {
  return JSON.stringify({
    error: { code, message: e instanceof Error ? e.message : String(e) },
  });
}

export async function runCommand(
  argv: string[],
  ctx: Context
): Promise<CommandResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  let config;
  try {
    config = loadConfig(ctx.configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      return { stdout: "", stderr: errorJson("SYSTEM", e), exitCode: 2 };
    }
    throw e;
  }

  const withDb = (fn: (db: Db) => unknown) => () => {
    const db = openStore(ctx.dbPath, ctx.clock);
    try {
      stdout = JSON.stringify(fn(db));
    } finally {
      db.close();
    }
  };

  const cli = cac("mem");
  cli
    .command("add <kind>", "capture a node")
    .option("--title <title>", "node title")
    .option("--body <md>", "markdown body")
    .option("--payload <json>", "kind payload")
    .option("--tag <tag>", "tag (repeatable)")
    .option("--link <id:rel>", "edge to an existing node (repeatable)")
    .option("--status <status>", "lifecycle status")
    .option("--occurred-at <iso>", "when it happened")
    .action(
      (
        kind: string,
        opts: {
          title?: string;
          body?: string;
          payload?: string;
          tag?: string | string[];
          link?: string | string[];
          status?: string;
          occurredAt?: string;
        }
      ) => {
        if (typeof opts.title !== "string" || opts.title === "") {
          throw new UserError("INVALID_ARGS", "--title is required");
        }
        withDb((db) =>
          addCommand(db, ctx, {
            kind,
            title: opts.title as string,
            body: opts.body,
            payload: opts.payload,
            tags: many(opts.tag),
            links: many(opts.link).map(parseLinkFlag),
            status: opts.status,
            occurredAt: opts.occurredAt,
          })
        )();
      }
    );
  cli
    .command("get <id>", "fetch one node")
    .option("--with-edges", "include in/out edges")
    .option("--with-body", "include full body")
    .action((id: string, opts: { withEdges?: boolean; withBody?: boolean }) => {
      withDb((db) => getCommand(db, id, opts))();
    });
  cli
    .command("update <id>", "update a node")
    .option("--title <title>", "new title")
    .option("--body <md>", "new body")
    .option("--payload-merge <json>", "RFC 7386 merge patch")
    .option("--status <status>", "new status")
    .option("--occurred-at <iso>", "new occurred_at")
    .action((id: string, opts: UpdateArgs & Record<string, unknown>) => {
      withDb((db) =>
        updateCommand(db, ctx, id, {
          title: opts.title,
          body: opts.body,
          payloadMerge: opts.payloadMerge,
          status: opts.status,
          occurredAt: opts.occurredAt,
        })
      )();
    });
  cli.command("delete <id>", "soft delete").action((id: string) => {
    withDb((db) => deleteCommand(db, ctx, id))();
  });
  cli.command("restore <id>", "reverse a soft delete").action((id: string) => {
    withDb((db) => restoreCommand(db, ctx, id))();
  });
  cli
    .command("purge", "hard-delete old soft-deleted nodes")
    .option("--older-than <days>", "retention window override")
    .action((opts: { olderThan?: string }) => {
      const days =
        opts.olderThan === undefined ? undefined : Number(opts.olderThan);
      if (days !== undefined && !Number.isFinite(days)) {
        throw new UserError("INVALID_ARGS", "--older-than must be a number");
      }
      withDb((db) => purgeCommand(db, ctx, config, days))();
    });
  cli
    .command("link <src> <dst> <rel>", "create an edge")
    .option("--weight <n>", "edge weight")
    .action(
      (src: string, dst: string, rel: string, opts: { weight?: string }) => {
        const weight =
          opts.weight === undefined ? undefined : Number(opts.weight);
        if (weight !== undefined && !Number.isFinite(weight)) {
          throw new UserError("INVALID_ARGS", "--weight must be a number");
        }
        withDb((db) => linkCommand(db, ctx, src, dst, rel, weight))();
      }
    );
  cli
    .command("unlink <src> <dst> <rel>", "remove an edge")
    .action((src: string, dst: string, rel: string) => {
      withDb((db) => unlinkCommand(db, src, dst, rel))();
    });
  cli
    .command("tag <id> [...tags]", "add tags")
    .action((id: string, tags: string[]) => {
      if (tags.length === 0) {
        throw new UserError("INVALID_ARGS", "at least one tag required");
      }
      withDb((db) => tagCommand(db, id, tags))();
    });
  cli
    .command("untag <id> [...tags]", "remove tags")
    .action((id: string, tags: string[]) => {
      if (tags.length === 0) {
        throw new UserError("INVALID_ARGS", "at least one tag required");
      }
      withDb((db) => untagCommand(db, id, tags))();
    });
  cli
    .command("query [text]", "retrieval: FTS + filters")
    .action((text?: string) => {
      withDb((db) => queryCommand(db, text ?? ""))();
    });
  cli
    .command("kinds [kind]", "contract self-discovery")
    .action((kind?: string) => {
      stdout = JSON.stringify(kindsCommand(kind));
    });
  cli
    .command("stats", "node/edge/tag counts by kind")
    .action(withDb((db) => statsCommand(db)));

  try {
    cli.parse(["mem-node", "mem", ...argv], { run: false });
    await cli.runMatchedCommand();
  } catch (e) {
    stdout = "";
    if (e instanceof UserError) {
      stderr = errorJson(e.code, e);
      exitCode = 1;
    } else {
      stderr = errorJson("SYSTEM", e);
      exitCode = 2;
    }
  }

  if (config.warnings.length > 0) {
    stderr = [...config.warnings, stderr].filter(Boolean).join("\n");
  }
  return { stdout, stderr, exitCode };
}
