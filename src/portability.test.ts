import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { makeTestContext, seedStandardGraph, testId } from "./testing";

describe("Item 9 — stats / export / import / backup", () => {
  it("T9.1 stats counts the standard graph", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const stats = JSON.parse((await runCommand(["stats"], ctx)).stdout);

    expect(stats).toEqual({
      nodes: {
        project: 1,
        task: 2,
        person: 1,
        note: 1,
        meal: 1,
        symptom: 1,
        transaction: 1,
      },
      edges: 3,
      tags: 3,
      suggestions_pending: 0,
      deleted: 0,
    });
  });

  it("stats: soft-deleted nodes leave kind counts and surface under deleted", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["delete", testId(5)], ctx);

    const stats = JSON.parse((await runCommand(["stats"], ctx)).stdout);

    expect(stats.nodes.note).toBeUndefined(); // only live nodes counted
    expect(stats.deleted).toBe(1);
  });

  it("T9.2 export/import round-trip preserves soft-deleted nodes", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["delete", testId(5)], ctx);

    const exported = await runCommand(["export"], ctx);
    expect(exported.exitCode).toBe(0);
    const lines = exported.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(8); // soft-deleted included
    const deletedLine = lines.find((l) => l.node.id === testId(5));
    expect(deletedLine.node.deleted_at).not.toBeNull();
    expect(deletedLine.node.body).toContain("payment capture");
    expect(deletedLine.edges_out).toEqual([
      expect.objectContaining({ dst: testId(4), rel: "about" }),
    ]);

    // fresh second DB
    const ctx2 = makeTestContext();
    const file = `${ctx2.dbPath}.export.jsonl`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, exported.stdout);

    const imported = await runCommand(["import", file], ctx2);
    expect(JSON.parse(imported.stdout)).toEqual({
      imported: 8,
      skipped: 0,
      edges_skipped: 0,
      suggestions_skipped: 0,
    });

    const [a, b] = await Promise.all([
      runCommand(["stats"], ctx),
      runCommand(["stats"], ctx2),
    ]);
    expect(JSON.parse(b.stdout)).toEqual(JSON.parse(a.stdout));

    // soft-deleted stays deleted in the copy; FTS rebuilt for live nodes
    const copy = JSON.parse(
      (await runCommand(["get", testId(5)], ctx2)).stdout
    );
    expect(copy.deleted_at).not.toBeNull();
    const hits = JSON.parse(
      (await runCommand(["query", "safekeep"], ctx2)).stdout
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it("T9.2b dangling edge is skipped and counted", async () => {
    const ctx = makeTestContext();
    const line = JSON.stringify({
      node: {
        id: testId(50),
        kind: "note",
        title: "orphan",
        body: "",
        payload: {},
        status: null,
        occurred_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null,
      },
      edges_out: [
        {
          dst: testId(99),
          rel: "about",
          weight: 1,
          origin: "direct",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      tags: [],
    });
    const file = `${ctx.dbPath}.dangling.jsonl`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, line);

    const res = await runCommand(["import", file], ctx);
    expect(JSON.parse(res.stdout)).toEqual({
      imported: 1,
      skipped: 0,
      edges_skipped: 1,
      suggestions_skipped: 0,
    });
    expect((await runCommand(["get", testId(50)], ctx)).exitCode).toBe(0);
  });

  it("T9.2c suggestion state round-trips: rejected pairs never re-propose on the copy", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx); // meal <id:6> / symptom <id:7> same day
    await runCommand(["suggest"], ctx);
    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string }>;
    expect(pending.length).toBeGreaterThanOrEqual(2);
    // reject the meal↔symptom pair, leave the rest pending
    await runCommand(["suggest", "reject", testId(6), testId(7)], ctx);

    const exported = (await runCommand(["export"], ctx)).stdout;
    const ctx2 = makeTestContext();
    const file = `${ctx2.dbPath}.suggestions.jsonl`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, exported);

    const res = JSON.parse((await runCommand(["import", file], ctx2)).stdout);
    expect(res.suggestions_skipped).toBe(0);

    // pending backlog identical across the pair
    const [a, b] = await Promise.all([
      runCommand(["stats"], ctx),
      runCommand(["stats"], ctx2),
    ]);
    expect(JSON.parse(b.stdout).suggestions_pending).toBe(
      JSON.parse(a.stdout).suggestions_pending
    );

    // the rejected pair stays rejected: suggest on the copy never re-proposes it
    await runCommand(["suggest"], ctx2);
    const copyPending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx2)).stdout
    ) as Array<{ src: string; dst: string }>;
    const pair = copyPending.find(
      (s) => s.src === testId(6) && s.dst === testId(7)
    );
    expect(pair).toBeUndefined();
  });

  it("T9.2d dangling suggestion is skipped and counted; partial exports omit cross-set suggestions", async () => {
    const ctx = makeTestContext();
    const file = `${ctx.dbPath}.dangling-suggestion.jsonl`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      file,
      [
        JSON.stringify({
          node: {
            id: testId(60),
            kind: "note",
            title: "lonely endpoint",
            body: "",
            payload: {},
            status: null,
            occurred_at: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            deleted_at: null,
          },
          edges_out: [],
          tags: [],
        }),
        JSON.stringify({
          suggestion: {
            src: testId(60),
            dst: testId(99), // absent from file and DB
            score: 1,
            reason: "temporal-proximity:same-day",
            status: "rejected",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        }),
      ].join("\n")
    );

    const res = JSON.parse((await runCommand(["import", file], ctx)).stdout);
    expect(res).toEqual({
      imported: 1,
      skipped: 0,
      edges_skipped: 0,
      suggestions_skipped: 1,
    });

    // a kind-filtered export carries no suggestion whose other endpoint is outside the set
    const ctx2 = makeTestContext();
    await seedStandardGraph(ctx2);
    await runCommand(["suggest"], ctx2); // meal↔symptom pair exists
    const partial = (await runCommand(["export", "--kind", "meal"], ctx2))
      .stdout;
    const partialLines = partial
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(partialLines).toHaveLength(1);
    expect(partialLines[0].suggestion).toBeUndefined();
  });

  it("T9.3 re-import skips existing wholly", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    const exported = (await runCommand(["export"], ctx)).stdout;
    const file = `${ctx.dbPath}.again.jsonl`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, exported);

    const res = await runCommand(["import", file], ctx);
    expect(JSON.parse(res.stdout)).toEqual({
      imported: 0,
      skipped: 8,
      edges_skipped: 0,
      suggestions_skipped: 0,
    });
  });

  it("T9.4 export filters by kind", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const res = await runCommand(["export", "--kind", "meal"], ctx);
    const lines = res.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).node.kind).toBe("meal");
  });

  it("T9.5 backup: VACUUM INTO snapshot with rotation", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    const { mkdtempSync, readdirSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dest = mkdtempSync(join(tmpdir(), "mem-backup-"));

    let last: { path: string; kept: number } | undefined;
    for (let i = 0; i < 3; i++) {
      const res = await runCommand(
        ["backup", "--dest", dest, "--keep", "2"],
        ctx
      );
      expect(res.exitCode).toBe(0);
      last = JSON.parse(res.stdout);
    }

    expect(last!.kept).toBe(2);
    expect(existsSync(last!.path)).toBe(true);
    const files = readdirSync(dest).filter((f) => f.endsWith(".db"));
    expect(files).toHaveLength(2);

    // snapshot is an openable database containing the data
    const { openDatabase } = await import("./sqlite");
    const snap = openDatabase(last!.path);
    expect(snap.get("SELECT COUNT(*) AS n FROM nodes")?.n).toBe(8);
    snap.close();
  });
});
