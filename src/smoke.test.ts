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
        deleted: 0,
      });
    }

    const db = openDatabase(join(dataHome, "nook", "memory.db"));
    const rows = db.all("SELECT version FROM schema_migrations");
    db.close();
    expect(rows.map((r) => r.version)).toEqual([1]);
  });

  it("T8.9 --human query output is markdown, not JSON", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "mem-smoke-"));
    await spawnMem(
      ["add", "note", "--title", "Safekeep launch checklist"],
      dataHome
    );

    const added = await spawnMem(["query", "safekeep"], dataHome).then(
      (r) => JSON.parse(r.stdout)[0]
    );
    const res = await spawnMem(["query", "safekeep", "--human"], dataHome);

    expect(res.stdout.trimStart().startsWith("- ")).toBe(true);
    expect(res.stdout).toContain("Safekeep launch checklist");
    expect(res.stdout).toContain("note");
    expect(res.stdout).toContain(added.id);
    expect(() => JSON.parse(res.stdout)).toThrow();
  });
});
