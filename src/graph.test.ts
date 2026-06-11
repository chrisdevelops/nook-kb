import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { makeTestContext, seedStandardGraph, testId } from "./testing";

describe("Item 11 — query graph expansion (--hops)", () => {
  it("T11.1 default 1-hop expansion: neighbor surfaces with hops:1 and a via path", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    // seed: <id:5> (note body "payment capture…"); 1 hop: <id:5> -about-> <id:4>
    const hits = JSON.parse(
      (await runCommand(["query", "payment capture"], ctx)).stdout
    );

    expect(hits.map((h: { id: string }) => h.id)).toEqual([
      testId(5),
      testId(4),
    ]);
    const [seed, expanded] = hits;
    expect(seed.hops).toBe(0);
    expect(seed.via).toBeNull();
    expect(expanded.hops).toBe(1);
    expect(expanded.via).toEqual([`${testId(5)} -about-> ${testId(4)}`]);
    expect(expanded.snippet).toBeNull(); // not an FTS match
    expect(expanded.score).toBeGreaterThan(0);
  });

  it("T11.2 --hops bounds the depth; via lists the full path in order", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    // chain: <id:5> -about-> <id:4>; new note -derived_from-> <id:4> puts it
    // at 2 hops from the "payment capture" seed
    const far = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "note",
            "--title",
            "Client preferences",
            "--link",
            `${testId(4)}:derived_from`,
          ],
          ctx
        )
      ).stdout
    );

    const oneHop = JSON.parse(
      (await runCommand(["query", "payment capture", "--hops", "1"], ctx))
        .stdout
    );
    expect(oneHop.map((h: { id: string }) => h.id)).not.toContain(far.id);

    const twoHops = JSON.parse(
      (await runCommand(["query", "payment capture", "--hops", "2"], ctx))
        .stdout
    );
    const hit = twoHops.find((h: { id: string }) => h.id === far.id);
    expect(hit.hops).toBe(2);
    expect(hit.via).toEqual([
      `${testId(5)} -about-> ${testId(4)}`,
      `${far.id} -derived_from-> ${testId(4)}`,
    ]);
  });

  it("T11.2b --hops outside 1..3 is INVALID_ARGS", async () => {
    const ctx = makeTestContext();
    for (const bad of ["0", "4", "1.5"]) {
      const res = await runCommand(["query", "x", "--hops", bad], ctx);
      expect(res.exitCode).toBe(1);
      expect(JSON.parse(res.stderr).error.code).toBe("INVALID_ARGS");
    }
  });

  it("T11.3 closed nodes are traversable intermediates but never results", async () => {
    const ctx = makeTestContext();
    const add = async (args: string[]) =>
      JSON.parse((await runCommand(["add", ...args], ctx)).stdout);
    const hub = await add(["project", "--title", "Mushroom farm"]);
    const a = await add([
      "note",
      "--title",
      "Spore logistics research",
      "--link",
      `${hub.id}:part_of`,
    ]);
    const b = await add([
      "note",
      "--title",
      "Substrate suppliers",
      "--link",
      `${hub.id}:part_of`,
    ]);
    await runCommand(["update", hub.id, "--status", "archived"], ctx);

    // live↔live path through the archived hub still resolves
    const hits = JSON.parse(
      (await runCommand(["query", "spore logistics", "--hops", "2"], ctx))
        .stdout
    ) as Array<{ id: string; hops: number; via: string[] | null }>;
    expect(hits.map((h) => h.id)).toEqual([a.id, b.id]);
    const reached = hits.find((h) => h.id === b.id)!;
    expect(reached.hops).toBe(2);
    expect(reached.via).toEqual([
      `${a.id} -part_of-> ${hub.id}`,
      `${b.id} -part_of-> ${hub.id}`,
    ]); // via names the closed hub — that's the explanation trail

    // --include-closed lifts the result-level exclusion
    const withClosed = JSON.parse(
      (
        await runCommand(
          ["query", "spore logistics", "--hops", "2", "--include-closed"],
          ctx
        )
      ).stdout
    ) as Array<{ id: string; hops: number }>;
    expect(withClosed.find((h) => h.id === hub.id)?.hops).toBe(1);
  });

  it("T11.4 soft-deleted nodes block traversal: not seeds, results, or intermediates", async () => {
    const ctx = makeTestContext();
    const add = async (args: string[]) =>
      JSON.parse((await runCommand(["add", ...args], ctx)).stdout);
    const a = await add(["note", "--title", "Fermentation timing notes"]);
    const mid = await add([
      "note",
      "--title",
      "Brine ratios",
      "--link",
      `${a.id}:references`,
    ]);
    const b = await add([
      "note",
      "--title",
      "Jar suppliers",
      "--link",
      `${mid.id}:references`,
    ]);
    await runCommand(["delete", mid.id], ctx);

    for (const argv of [
      ["query", "fermentation timing", "--hops", "2"],
      ["query", "fermentation timing", "--hops", "2", "--include-closed"],
    ]) {
      const ids = (
        JSON.parse((await runCommand(argv, ctx)).stdout) as { id: string }[]
      ).map((h) => h.id);
      expect(ids).toEqual([a.id]); // mid gone, b unreachable through it
    }
    expect(b.id).toBeDefined();
  });

  it("T11.5 ordering property: FTS seed above 1-hop above 2-hop (never score values)", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    const far = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "note",
            "--title",
            "Client preferences",
            "--link",
            `${testId(4)}:derived_from`,
          ],
          ctx
        )
      ).stdout
    );

    const ids = (
      JSON.parse(
        (await runCommand(["query", "payment capture", "--hops", "2"], ctx))
          .stdout
      ) as { id: string }[]
    ).map((h) => h.id);

    expect(ids.indexOf(testId(5))).toBeLessThan(ids.indexOf(testId(4)));
    expect(ids.indexOf(testId(4))).toBeLessThan(ids.indexOf(far.id));
  });

  it("T11.6 chunk dedup survives expansion: one row per document either way", async () => {
    const para = (n: number) =>
      `Paragraph ${n} of the episode covers a topic in some depth, wandering through examples and asides.`;
    const body = Array.from({ length: 370 }, (_, i) =>
      i === 200
        ? `${para(i + 1)} The zanzibar anecdote lands here.`
        : para(i + 1)
    ).join("\n\n");
    const ctx = makeTestContext({ stdin: body });
    const source = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "source",
            "--title",
            "Pod ep 41",
            "--payload",
            '{"source_type":"podcast"}',
            "--tag",
            "media/podcast",
            "--body-stdin",
          ],
          ctx
        )
      ).stdout
    );
    expect(source.chunks_created).toBeGreaterThan(1);

    // term unique to one chunk: that chunk wins; source and expansion-dragged
    // siblings are deduped away
    const byTerm = JSON.parse(
      (await runCommand(["query", "zanzibar"], ctx)).stdout
    ) as Array<{ id: string; kind: string; hops: number }>;
    expect(byTerm).toHaveLength(1);
    expect(byTerm[0]!.kind).toBe("chunk");
    expect(byTerm[0]!.hops).toBe(0);

    // tag matches the source only: chunks arrive via expansion alone and must
    // not displace the real match
    const byTag = JSON.parse(
      (await runCommand(["query", "podcast"], ctx)).stdout
    ) as Array<{ id: string }>;
    expect(byTag.map((h) => h.id)).toEqual([source.id]);
  });
});

describe("Item 12 — related (pure graph neighborhood)", () => {
  it("T12.1 neighbors at 1 hop in the reserved shape; closed nodes fully visible", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const res = await runCommand(["related", testId(1)], ctx);

    expect(res.exitCode).toBe(0);
    const items = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
    // <id:2> (open task) and <id:3> (done task — closed stays visible here)
    expect(items.map((i) => i.id).sort()).toEqual([testId(2), testId(3)]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        "hops",
        "id",
        "kind",
        "title",
        "via",
      ]);
      expect(item.hops).toBe(1);
    }
    expect(items.find((i) => i.id === testId(2))!.via).toEqual([
      `${testId(2)} -part_of-> ${testId(1)}`,
    ]);
  });

  it("T12.2 respects --hops and --limit; nearer neighbors rank first", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    // chain off <id:4>: <id:5> at 1 hop (about), far at 2 hops
    const far = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "note",
            "--title",
            "Client preferences",
            "--link",
            `${testId(5)}:derived_from`,
          ],
          ctx
        )
      ).stdout
    );

    const oneHop = JSON.parse(
      (await runCommand(["related", testId(4)], ctx)).stdout
    ) as Array<{ id: string }>;
    expect(oneHop.map((i) => i.id)).not.toContain(far.id); // default depth 1

    const twoHops = JSON.parse(
      (await runCommand(["related", testId(4), "--hops", "2"], ctx)).stdout
    ) as Array<{ id: string; hops: number }>;
    const ids = twoHops.map((i) => i.id);
    expect(ids.indexOf(testId(5))).toBeLessThan(ids.indexOf(far.id));
    expect(twoHops.find((i) => i.id === far.id)!.hops).toBe(2);

    const limited = JSON.parse(
      (
        await runCommand(
          ["related", testId(4), "--hops", "2", "--limit", "1"],
          ctx
        )
      ).stdout
    );
    expect(limited).toHaveLength(1);
  });

  it("T12.3 shared-tag nodes appended after graph neighbors as weak relations", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    // graph neighbor for <id:6>, plus a node sharing its health/food tag
    await runCommand(["link", testId(7), testId(6), "evidences"], ctx);
    const grocery = JSON.parse(
      (
        await runCommand(
          ["add", "note", "--title", "Groceries run", "--tag", "health/food"],
          ctx
        )
      ).stdout
    );

    const items = JSON.parse(
      (await runCommand(["related", testId(6)], ctx)).stdout
    ) as Array<{ id: string; hops: number | null; via: string[] }>;

    // edge neighbors first, then tag-implied weak relations
    expect(items.map((i) => i.id)).toEqual([testId(7), grocery.id]);
    const weak = items[1]!;
    expect(weak.hops).toBeNull(); // not an edge hop
    expect(weak.via).toEqual(["shared-tag:health/food"]);
  });

  it("T12.4 soft-deleted: rejected as root, absent as neighbor or weak relation", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["delete", testId(5)], ctx);

    const asRoot = await runCommand(["related", testId(5)], ctx);
    expect(asRoot.exitCode).toBe(1);
    expect(JSON.parse(asRoot.stderr).error.code).toBe("NOT_FOUND");

    // <id:5> was <id:4>'s only edge neighbor; deletion empties the result
    const neighbors = JSON.parse(
      (await runCommand(["related", testId(4)], ctx)).stdout
    );
    expect(neighbors).toEqual([]);

    // deleted node sharing health/food must not appear as a weak relation
    await runCommand(
      ["add", "note", "--title", "Old groceries", "--tag", "health/food"],
      ctx
    );
    const gone = JSON.parse(
      (await runCommand(["delete", "TESTID00000000000000000009"], ctx)).stdout
    );
    expect(gone.deleted_at).not.toBeNull();
    const weak = JSON.parse(
      (await runCommand(["related", testId(6)], ctx)).stdout
    );
    expect(weak).toEqual([]);
  });
});
