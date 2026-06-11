import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openDatabase } from "./sqlite";

const exec = promisify(execFile);
const ENTRY = join(import.meta.dirname, "index.ts");

/** Spawn the real binary under Bun with an isolated XDG_DATA_HOME. */
function spawnMem(args: string[], dataHome: string) {
  return exec("bun", [ENTRY, ...args], {
    env: { ...process.env, XDG_DATA_HOME: dataHome },
  });
}

describe("smoke — real binary", () => {
  it("T2.4 concurrent first run: both exit 0, migrations applied once", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "mem-smoke-"));

    const [a, b] = await Promise.all([
      spawnMem(["stats"], dataHome),
      spawnMem(["stats"], dataHome),
    ]);

    for (const r of [a, b]) {
      expect(JSON.parse(r.stdout)).toEqual({
        nodes: {},
        edges: 0,
        tags: 0,
        suggestions_pending: 0,
      });
    }

    const db = openDatabase(join(dataHome, "nook", "memory.db"));
    const rows = db.all("SELECT version FROM schema_migrations");
    db.close();
    expect(rows.map((r) => r.version)).toEqual([1]);
  });
});
