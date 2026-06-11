import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { makeTestContext, seedStandardGraph, testId } from "./testing";

describe("Item 13 — suggester (suggest / review / accept / reject)", () => {
  it("T13.1 cross-kind health pair within the same-day window is proposed", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx); // meal <id:6> 08:00, symptom <id:7> 14:00 same day

    const res = await runCommand(["suggest"], ctx);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).created).toBeGreaterThanOrEqual(1);

    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string; reason: string; score: number }>;
    const pair = pending.find(
      (s) => s.src === testId(6) && s.dst === testId(7) // canonical src < dst
    );
    expect(pair).toBeDefined();
    expect(pair!.reason).toContain("same-day");
  });

  it("T13.2 same-kind proximity excluded; next-day in, two-days-later out", async () => {
    const ctx = makeTestContext();
    const add = async (args: string[]) =>
      JSON.parse((await runCommand(["add", ...args], ctx)).stdout);
    const lunch = await add([
      "meal",
      "--title",
      "Lunch",
      "--payload",
      '{"items":["soup"]}',
      "--occurred-at",
      "2026-01-01T12:00:00.000Z",
    ]);
    const dinner = await add([
      "meal",
      "--title",
      "Dinner",
      "--payload",
      '{"items":["pasta"]}',
      "--occurred-at",
      "2026-01-01T19:00:00.000Z",
    ]);
    const nextDay = await add([
      "symptom",
      "--title",
      "Bloating",
      "--payload",
      '{"name":"bloating"}',
      "--occurred-at",
      "2026-01-02T09:00:00.000Z",
    ]);
    const farOut = await add([
      "symptom",
      "--title",
      "Fatigue",
      "--payload",
      '{"name":"fatigue"}',
      "--occurred-at",
      "2026-01-03T09:00:00.000Z",
    ]);

    await runCommand(["suggest"], ctx);
    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string; reason: string }>;
    const pairs = pending.map((s) => `${s.src}|${s.dst}`);

    // meal↔meal same-day adjacency is daily noise — never proposed
    expect(pairs).not.toContain(`${lunch.id}|${dinner.id}`);
    // meal → next-day symptom is in the window
    const next = pending.find(
      (s) => s.src === dinner.id && s.dst === nextDay.id
    );
    expect(next!.reason).toContain("next-day");
    // two days out is beyond the configured windows
    expect(pairs).not.toContain(`${dinner.id}|${farOut.id}`);
    // symptom↔symptom next-day is same-kind too
    expect(pairs).not.toContain(`${nextDay.id}|${farOut.id}`);
  });

  it("T13.3 shared-tag overlap proposes the pair and names the tag", async () => {
    const ctx = makeTestContext();
    const add = async (args: string[]) =>
      JSON.parse((await runCommand(["add", ...args], ctx)).stdout);
    const a = await add([
      "note",
      "--title",
      "Crow taxidermy sketches",
      "--tag",
      "story/crows",
    ]);
    const b = await add([
      "note",
      "--title",
      "Murder plot outline",
      "--tag",
      "story/crows",
    ]);
    const untagged = await add(["note", "--title", "Tax receipts"]);
    const gone = await add([
      "note",
      "--title",
      "Old crow notes",
      "--tag",
      "story/crows",
    ]);
    await runCommand(["delete", gone.id], ctx);

    await runCommand(["suggest"], ctx);
    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string; reason: string }>;
    const pairs = pending.map((s) => `${s.src}|${s.dst}`);

    expect(pairs).toContain(`${a.id}|${b.id}`); // canonical src < dst
    expect(
      pending.find((s) => s.src === a.id && s.dst === b.id)!.reason
    ).toContain("shared-tags:story/crows");
    // no tag overlap, no temporal/health angle → not a candidate
    expect(pairs.filter((p) => p.includes(untagged.id))).toEqual([]);
    // soft-deleted nodes are not candidates
    expect(pairs.filter((p) => p.includes(gone.id))).toEqual([]);
  });

  it("T13.4 FTS similarity proposes overlapping titles; chunks stay out of it", async () => {
    const para = (n: number) =>
      `Paragraph ${n} of the recording meanders through fermentation talk at length, as these conversations tend to do.`;
    const ctx = makeTestContext({
      stdin: Array.from({ length: 370 }, (_, i) => para(i + 1)).join("\n\n"),
    });
    const add = async (args: string[]) =>
      JSON.parse((await runCommand(["add", ...args], ctx)).stdout);
    const a = await add(["note", "--title", "Sourdough starter hydration log"]);
    const b = await add(["note", "--title", "Sourdough hydration experiments"]);
    const unrelated = await add(["note", "--title", "Bike maintenance"]);
    const source = await add([
      "source",
      "--title",
      "Fermentation pod ep 12",
      "--payload",
      '{"source_type":"podcast"}',
      "--body-stdin",
    ]);
    expect(source.chunks_created).toBeGreaterThan(1);

    await runCommand(["suggest"], ctx);
    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string; reason: string }>;
    const pairs = pending.map((s) => `${s.src}|${s.dst}`);

    expect(pairs).toContain(`${a.id}|${b.id}`);
    expect(pending.find((s) => s.src === a.id && s.dst === b.id)!.reason).toBe(
      "fts-similarity"
    );
    // one shared common word is not similarity
    expect(pairs.filter((p) => p.includes(unrelated.id))).toEqual([]);
    // near-identical chunk-sibling titles are mechanical, not similarity
    const chunkIds = new Set(
      pending
        .flatMap((s) => [s.src, s.dst])
        .filter((id) => id !== a.id && id !== b.id && id !== unrelated.id)
    );
    expect([...chunkIds].filter((id) => id !== source.id)).toEqual([]);
  });

  it("T13.5 pairs already connected by any edge are not proposed", async () => {
    const ctx = makeTestContext();
    const add = async (args: string[]) =>
      JSON.parse((await runCommand(["add", ...args], ctx)).stdout);
    const a = await add([
      "note",
      "--title",
      "Greenhouse irrigation",
      "--tag",
      "garden/plans",
    ]);
    const b = await add([
      "note",
      "--title",
      "Raised bed layout",
      "--tag",
      "garden/plans",
      "--link",
      `${a.id}:relates_to`,
    ]);

    const res = JSON.parse((await runCommand(["suggest"], ctx)).stdout);
    expect(res.created).toBe(0);
    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string }>;
    expect(pending.filter((s) => s.src === a.id || s.dst === b.id)).toEqual([]);
  });

  it("T13.6 accept creates the suggested edge and flips the row — reversed args included", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["suggest"], ctx);
    const before = JSON.parse(
      (await runCommand(["stats"], ctx)).stdout
    ).suggestions_pending;
    expect(before).toBeGreaterThanOrEqual(1);

    // canonical row is (<id:6>, <id:7>); accept with the arguments reversed
    const res = await runCommand(
      ["suggest", "accept", testId(7), testId(6)],
      ctx
    );
    expect(res.exitCode).toBe(0);
    const accepted = JSON.parse(res.stdout);
    expect(accepted.status).toBe("accepted");
    expect(accepted.edge).toEqual({
      src: testId(6),
      dst: testId(7),
      rel: "relates_to",
      weight: 1.0,
      origin: "suggested",
    });

    // row flipped: out of review, out of the stats backlog
    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string }>;
    expect(
      pending.find((s) => s.src === testId(6) && s.dst === testId(7))
    ).toBeUndefined();
    const after = JSON.parse(
      (await runCommand(["stats"], ctx)).stdout
    ).suggestions_pending;
    expect(after).toBe(before - 1);

    // the edge is real and re-running suggest does not re-propose the pair
    const edges = JSON.parse(
      (await runCommand(["get", testId(6), "--with-edges"], ctx)).stdout
    ).edges;
    expect(edges.out).toContainEqual(
      expect.objectContaining({
        dst: testId(7),
        rel: "relates_to",
        origin: "suggested",
      })
    );
    await runCommand(["suggest"], ctx);
    const again = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string }>;
    expect(
      again.find((s) => s.src === testId(6) && s.dst === testId(7))
    ).toBeUndefined();

    // unknown pair → NOT_FOUND
    const missing = await runCommand(
      ["suggest", "accept", testId(1), testId(8)],
      ctx
    );
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stderr).error.code).toBe("NOT_FOUND");
  });

  it("T13.8 accept when the edge already exists keeps the existing origin", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["suggest"], ctx);
    // the pair gets linked manually after the suggestion was computed
    await runCommand(["link", testId(6), testId(7), "relates_to"], ctx);

    const res = await runCommand(
      ["suggest", "accept", testId(6), testId(7)],
      ctx
    );

    expect(res.exitCode).toBe(0);
    const accepted = JSON.parse(res.stdout);
    expect(accepted.status).toBe("accepted");
    expect(accepted.edge.origin).toBe("direct"); // silent no-op, origin kept

    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string }>;
    expect(
      pending.find((s) => s.src === testId(6) && s.dst === testId(7))
    ).toBeUndefined();
  });

  it("T13.7 rejected pairs never reappear, in either direction", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["suggest"], ctx);

    // reject with reversed arguments — canonical row is (<id:6>, <id:7>)
    const res = await runCommand(
      ["suggest", "reject", testId(7), testId(6)],
      ctx
    );
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      src: testId(6),
      dst: testId(7),
      status: "rejected",
    });

    // recompute twice: the pair stays gone and no edge ever appears
    await runCommand(["suggest"], ctx);
    await runCommand(["suggest"], ctx);
    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string }>;
    expect(
      pending.find((s) => s.src === testId(6) && s.dst === testId(7))
    ).toBeUndefined();
    const edges = JSON.parse(
      (await runCommand(["get", testId(6), "--with-edges"], ctx)).stdout
    ).edges;
    expect(edges.out).toEqual([]);
    expect(edges.in).toEqual([]);
  });
});
