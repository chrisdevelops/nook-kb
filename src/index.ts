#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import type { Context } from "./context";
import { runCommand } from "./run-command";

function realContext(): Context {
  const dataHome =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return {
    dbPath: join(dataHome, "nook", "memory.db"),
    configPath: join(configHome, "nook", "memory.jsonc"),
    clock: () => new Date(),
    generateId: () => ulid(),
  };
}

const { stdout, stderr, exitCode } = await runCommand(
  process.argv.slice(2),
  realContext()
);
if (stdout) process.stdout.write(stdout + "\n");
if (stderr) process.stderr.write(stderr + "\n");
process.exit(exitCode);
