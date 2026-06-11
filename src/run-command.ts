import { cac } from "cac";
import type { CommandResult, Context } from "./context";
import { ConfigError, loadConfig } from "./config";
import { UserError } from "./errors";
import { KINDS } from "./kinds";
import { openStore } from "./store";
import type { Db } from "./sqlite";

function kindContract(name: string) {
  const def = KINDS[name];
  if (!def) throw new UserError("UNKNOWN_KIND", `unknown kind "${name}"`);
  return {
    kind: name,
    statuses: def.statuses,
    default_status: def.defaultStatus,
    payload_schema: def.payload,
  };
}

function errorJson(code: string, e: unknown): string {
  return JSON.stringify({
    error: { code, message: e instanceof Error ? e.message : String(e) },
  });
}

function statsCommand(db: Db): unknown {
  const nodes: Record<string, number> = {};
  for (const row of db.all(
    "SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind"
  )) {
    nodes[row.kind as string] = row.n as number;
  }
  const count = (sql: string) => db.get(sql)?.n as number;
  return {
    nodes,
    edges: count("SELECT COUNT(*) AS n FROM edges"),
    tags: count("SELECT COUNT(*) AS n FROM tags"),
    suggestions_pending: count(
      "SELECT COUNT(*) AS n FROM link_suggestions WHERE status = 'pending'"
    ),
  };
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

  const cli = cac("mem");
  cli
    .command("kinds [kind]", "contract self-discovery")
    .action((kind?: string) => {
      stdout = JSON.stringify(
        kind === undefined
          ? Object.keys(KINDS).map(kindContract)
          : kindContract(kind)
      );
    });
  cli.command("stats", "node/edge/tag counts by kind").action(() => {
    const db = openStore(ctx.dbPath, ctx.clock);
    try {
      stdout = JSON.stringify(statsCommand(db));
    } finally {
      db.close();
    }
  });

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
