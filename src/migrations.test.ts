import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { runCommand } from "./run-command";
import { makeTestContext } from "./testing";
import { openDatabase } from "./sqlite";
import { openStore } from "./store";

describe("Item 2 — migrations", () => {
  it("T2.1 fresh database applies all migrations", async () => {
    const ctx = makeTestContext();
    expect(existsSync(ctx.dbPath)).toBe(false);

    const res = await runCommand(["stats"], ctx);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(JSON.parse(res.stdout)).toEqual({
      nodes: {},
      edges: 0,
      tags: 0,
      suggestions_pending: 0,
    });
    expect(existsSync(ctx.dbPath)).toBe(true);

    const db = openDatabase(ctx.dbPath);
    const versions = db
      .all("SELECT version FROM schema_migrations ORDER BY version")
      .map((r) => r.version);
    db.close();
    expect(versions).toEqual([1]);
  });

  it("T2.2 idempotent — second run performs no migration writes", async () => {
    const ctx = makeTestContext();
    await runCommand(["stats"], ctx);

    const read = () => {
      const db = openDatabase(ctx.dbPath);
      const rows = db.all("SELECT version, applied_at FROM schema_migrations");
      db.close();
      return rows;
    };
    const first = read();

    const res = await runCommand(["stats"], ctx);
    expect(res.exitCode).toBe(0);
    // same rows, same applied_at: nothing re-applied (clock advances per
    // call, so a rewrite would change the timestamp)
    expect(read()).toEqual(first);
  });

  it("T2.3 pragmas active", async () => {
    const ctx = makeTestContext();
    await runCommand(["stats"], ctx);

    // journal_mode = WAL persists in the file; visible from any connection
    const db = openDatabase(ctx.dbPath);
    expect(db.get("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    db.close();

    // foreign_keys is connection-scoped: assert on the store's own connection
    const store = openStore(ctx.dbPath, ctx.clock);
    expect(store.get("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    store.close();
  });
});
