import { cac } from "cac";
import { addCommand } from "./commands/add";
import { kindsCommand } from "./commands/kinds";
import { queryCommand } from "./commands/query";
import { statsCommand } from "./commands/stats";
import type { CommandResult, Context } from "./context";
import { ConfigError, loadConfig } from "./config";
import { UserError } from "./errors";
import { openStore } from "./store";
import type { Db } from "./sqlite";

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

  let warnings: string[] = [];
  try {
    warnings = loadConfig(ctx.configPath).warnings;
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
          status?: string;
          occurredAt?: string;
        }
      ) => {
        if (typeof opts.title !== "string" || opts.title === "") {
          throw new UserError("INVALID_ARGS", "--title is required");
        }
        const tags =
          opts.tag === undefined
            ? []
            : Array.isArray(opts.tag)
              ? opts.tag
              : [opts.tag];
        withDb((db) =>
          addCommand(db, ctx, {
            kind,
            title: opts.title as string,
            body: opts.body,
            payload: opts.payload,
            tags,
            status: opts.status,
            occurredAt: opts.occurredAt,
          })
        )();
      }
    );
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

  if (warnings.length > 0) {
    stderr = [...warnings, stderr].filter(Boolean).join("\n");
  }
  return { stdout, stderr, exitCode };
}
