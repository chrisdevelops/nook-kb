import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { openDatabase } from "./sqlite";
import { makeTestContext, seedStandardGraph, testId } from "./testing";

describe("Item 6 — get / update / delete / restore / purge", () => {
  it("T6.1 get default: canonical node, no body, no edges", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const res = await runCommand(["get", testId(2)], ctx);

    expect(res.exitCode).toBe(0);
    const node = JSON.parse(res.stdout);
    expect(node).toMatchObject({
      id: testId(2),
      kind: "task",
      title: "Ship Safekeep v1",
      payload: { due_at: "2026-02-01", priority: "high" },
      status: "open",
      body_length: 0,
    });
    expect("body" in node).toBe(false);
    expect("edges" in node).toBe(false);
  });

  it("T6.2 get with edges", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const node = JSON.parse(
      (await runCommand(["get", testId(2), "--with-edges"], ctx)).stdout
    );

    expect(node.edges.out).toHaveLength(1);
    expect(node.edges.out[0]).toMatchObject({
      dst: testId(1),
      rel: "part_of",
      weight: 1,
      origin: "direct",
    });
    expect(node.edges.in).toEqual([]);
  });

  it("T6.3 get missing is NOT_FOUND", async () => {
    const res = await runCommand(["get", testId(99)], makeTestContext());
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stderr).error.code).toBe("NOT_FOUND");
  });

  it("delete soft-deletes: response, de-index (T4.3), get still works (T6.3)", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const res = await runCommand(["delete", testId(5)], ctx);
    expect(res.exitCode).toBe(0);
    const del = JSON.parse(res.stdout);
    expect(del.id).toBe(testId(5));
    expect(typeof del.deleted_at).toBe("string");

    // T4.3: de-indexed
    const hits = JSON.parse(
      (await runCommand(["query", "payment capture"], ctx)).stdout
    );
    expect(hits).toEqual([]);

    // T6.3: still readable via get, deleted_at set
    const got = JSON.parse((await runCommand(["get", testId(5)], ctx)).stdout);
    expect(got.deleted_at).toBe(del.deleted_at);
  });

  it("T6.4 update merge semantics", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    const before = JSON.parse(
      (await runCommand(["get", testId(2)], ctx)).stdout
    );

    const res = await runCommand(
      ["update", testId(2), "--payload-merge", '{"priority":"low"}'],
      ctx
    );

    expect(res.exitCode).toBe(0);
    const node = JSON.parse(res.stdout);
    expect(node.payload).toEqual({ due_at: "2026-02-01", priority: "low" });
    expect(node.created_at).toBe(before.created_at);
    expect(node.updated_at > before.updated_at).toBe(true);
  });

  it("T4.2 update re-indexes", async () => {
    const ctx = makeTestContext();
    const { id } = JSON.parse(
      (await runCommand(["add", "note", "--title", "draft"], ctx)).stdout
    );

    await runCommand(
      ["update", id, "--title", "Mortgage renewal options"],
      ctx
    );

    const found = JSON.parse(
      (await runCommand(["query", "mortgage"], ctx)).stdout
    );
    expect(found.map((h: { id: string }) => h.id)).toEqual([id]);
    expect(
      JSON.parse((await runCommand(["query", "draft"], ctx)).stdout)
    ).toEqual([]);
  });

  it("T6.5 merge causing invalid payload fails whole", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const res = await runCommand(
      ["update", testId(2), "--payload-merge", '{"priority":"urgent"}'],
      ctx
    );

    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stderr).error.code).toBe("VALIDATION_FAILED");
    const node = JSON.parse((await runCommand(["get", testId(2)], ctx)).stdout);
    expect(node.payload).toEqual({ due_at: "2026-02-01", priority: "high" });
  });

  it("T6.5b merge null deletes key (RFC 7386)", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const node = JSON.parse(
      (
        await runCommand(
          ["update", testId(2), "--payload-merge", '{"due_at":null}'],
          ctx
        )
      ).stdout
    );
    expect(node.payload).toEqual({ priority: "high" });
  });

  it("T6.5c soft-deleted nodes are immutable", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["delete", testId(5)], ctx);

    // tag/link immutability asserted in #6 when those commands exist
    for (const argv of [
      ["update", testId(5), "--title", "x"],
      ["delete", testId(5)],
    ]) {
      const res = await runCommand(argv, ctx);
      expect(res.exitCode).toBe(1);
      expect(JSON.parse(res.stderr).error.code).toBe("NOT_FOUND");
    }
  });

  it("T6.5d restore reverses a soft delete", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["delete", testId(5)], ctx);

    const res = await runCommand(["restore", testId(5)], ctx);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ id: testId(5), deleted_at: null });

    // re-indexed and mutable again (top hit; expansion may trail neighbors)
    const hits = JSON.parse(
      (await runCommand(["query", "payment capture"], ctx)).stdout
    );
    expect(hits[0].id).toBe(testId(5));
    expect(
      (await runCommand(["update", testId(5), "--title", "Square notes"], ctx))
        .exitCode
    ).toBe(0);

    // idempotent on live nodes; NOT_FOUND on unknown ids
    expect((await runCommand(["restore", testId(5)], ctx)).exitCode).toBe(0);
    const missing = await runCommand(["restore", testId(99)], ctx);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stderr).error.code).toBe("NOT_FOUND");
  });

  it("T6.6 purge hard-deletes past the window and cascades", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["delete", testId(5)], ctx);

    // default window (30d): nothing old enough
    const kept = await runCommand(["purge"], ctx);
    expect(JSON.parse(kept.stdout)).toEqual({ purged: 0 });

    const purged = await runCommand(["purge", "--older-than", "0"], ctx);
    expect(JSON.parse(purged.stdout)).toEqual({ purged: 1 });

    // row, edges, tags gone; restore impossible; others intact
    const db = openDatabase(ctx.dbPath);
    expect(db.get("SELECT COUNT(*) AS n FROM nodes")?.n).toBe(7);
    expect(
      db.get(
        "SELECT COUNT(*) AS n FROM edges WHERE src = ? OR dst = ?",
        testId(5),
        testId(5)
      )?.n
    ).toBe(0);
    expect(
      db.get("SELECT COUNT(*) AS n FROM tags WHERE node_id = ?", testId(5))?.n
    ).toBe(0);
    db.close();
    expect((await runCommand(["restore", testId(5)], ctx)).exitCode).toBe(1);
    expect(
      JSON.parse((await runCommand(["get", testId(2)], ctx)).stdout).id
    ).toBe(testId(2));
  });
});
