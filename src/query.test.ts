import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { makeTestContext, seedStandardGraph, testId } from "./testing";

describe("Item 4/8 — FTS sync + query (capture & find slice)", () => {
  it("T4.1 added node is findable", async () => {
    const ctx = makeTestContext();
    const added = JSON.parse(
      (
        await runCommand(
          ["add", "note", "--title", "Tailscale subnet routing"],
          ctx
        )
      ).stdout
    );

    const res = await runCommand(["query", "tailscale"], ctx);

    expect(res.exitCode).toBe(0);
    const hits = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe(added.id);
  });

  it("T4.4 tags are searchable", async () => {
    const ctx = makeTestContext();
    const added = JSON.parse(
      (
        await runCommand(
          ["add", "note", "--title", "restless night", "--tag", "health/sleep"],
          ctx
        )
      ).stdout
    );

    const hits = JSON.parse((await runCommand(["query", "sleep"], ctx)).stdout);
    expect(hits.map((h: { id: string }) => h.id)).toEqual([added.id]);
  });

  it("T8.1 result carries the seven contract keys with a highlighted snippet", async () => {
    const ctx = makeTestContext();
    await runCommand(
      [
        "add",
        "note",
        "--title",
        "Square gotchas",
        "--body",
        "the payment capture window closes after seven days",
      ],
      ctx
    );

    const hits = JSON.parse(
      (await runCommand(["query", "payment capture"], ctx)).stdout
    );
    expect(hits).toHaveLength(1);
    expect(Object.keys(hits[0]).sort()).toEqual(
      ["hops", "id", "kind", "score", "snippet", "title", "via"].sort()
    );
    expect(hits[0].hops).toBe(0);
    expect(hits[0].via).toBeNull();
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain("<b>");
  });

  it("T8.8 no results is success", async () => {
    const res = await runCommand(["query", "zxqv"], makeTestContext());
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual([]);
  });

  it("T8.2 kind filter", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const hits = JSON.parse(
      (await runCommand(["query", "safekeep", "--kind", "task"], ctx)).stdout
    ) as Array<{ id: string; kind: string }>;

    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.kind).toBe("task");
    expect(hits.map((h) => h.id)).not.toContain(testId(1));
  });

  it("T8.3 tag + time filters apply to occurred_at", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    // "breakfast", not "oatmeal": payloads are not FTS-indexed (SPEC §3.1
    // indexes title/body/tags only) — TDD T8.3 amended accordingly
    const inWindow = JSON.parse(
      (
        await runCommand(
          [
            "query",
            "breakfast",
            "--tag",
            "health/food",
            "--since",
            "2026-01-01",
            "--until",
            "2026-01-02",
          ],
          ctx
        )
      ).stdout
    );
    expect(inWindow.map((h: { id: string }) => h.id)).toEqual([testId(6)]);

    const outOfWindow = JSON.parse(
      (await runCommand(["query", "breakfast", "--since", "2026-01-02"], ctx))
        .stdout
    );
    expect(outOfWindow).toEqual([]);
  });

  it("T8.4 terminal-state exclusion and --include-closed", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const byDefault = JSON.parse(
      (await runCommand(["query", "safekeep"], ctx)).stdout
    ).map((h: { id: string }) => h.id);
    expect(byDefault).not.toContain(testId(3)); // done task hidden

    const withClosed = JSON.parse(
      (await runCommand(["query", "safekeep", "--include-closed"], ctx)).stdout
    ).map((h: { id: string }) => h.id);
    expect(withClosed).toContain(testId(3));

    await runCommand(["update", testId(1), "--status", "archived"], ctx);
    const afterArchive = JSON.parse(
      (await runCommand(["query", "safekeep"], ctx)).stdout
    ).map((h: { id: string }) => h.id);
    expect(afterArchive).not.toContain(testId(1));
  });

  it("T8.5 soft-deleted excluded even with --include-closed", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["delete", testId(5)], ctx);

    for (const argv of [
      ["query", "payment capture"],
      ["query", "payment capture", "--include-closed"],
    ]) {
      const hits = JSON.parse((await runCommand(argv, ctx)).stdout);
      expect(hits.map((h: { id: string }) => h.id)).not.toContain(testId(5));
    }
  });

  it("T8.6 ordering property: title match outranks body-only match", async () => {
    const ctx = makeTestContext();
    await runCommand(
      ["add", "note", "--title", "misc", "--body", "kubernetes mentioned once"],
      ctx
    );
    await runCommand(["add", "note", "--title", "kubernetes ingress"], ctx);

    const hits = JSON.parse(
      (await runCommand(["query", "kubernetes"], ctx)).stdout
    );
    expect(hits.map((h: { title: string }) => h.title)).toEqual([
      "kubernetes ingress",
      "misc",
    ]);
  });

  it("T8.7 limit", async () => {
    const ctx = makeTestContext();
    for (let i = 1; i <= 5; i++) {
      await runCommand(["add", "note", "--title", `gardening tip ${i}`], ctx);
    }

    const hits = JSON.parse(
      (await runCommand(["query", "gardening", "--limit", "2"], ctx)).stdout
    );
    expect(hits).toHaveLength(2);
  });

  it("T8.10 no-text listing mode", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const open = JSON.parse(
      (await runCommand(["query", "--kind", "task", "--status", "open"], ctx))
        .stdout
    );
    expect(open.map((h: { id: string }) => h.id)).toEqual([testId(2)]);
    expect(open[0].score).toBeNull();
    expect(open[0].snippet).toBeNull();

    const meals = JSON.parse(
      (
        await runCommand(
          ["query", "--kind", "meal", "--since", "2026-01-01"],
          ctx
        )
      ).stdout
    );
    expect(meals.map((h: { id: string }) => h.id)).toEqual([testId(6)]);

    // recency order: listing is occurred_at→created_at descending
    const all = JSON.parse((await runCommand(["query"], ctx)).stdout);
    const keys = all.map((h: { id: string }) => h.id);
    expect(keys.indexOf(testId(7))).toBeLessThan(keys.indexOf(testId(6))); // 14:00 before 08:00
  });
});
