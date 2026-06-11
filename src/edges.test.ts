import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { openDatabase } from "./sqlite";
import { makeTestContext, seedStandardGraph, testId } from "./testing";

describe("Item 7 — link / unlink / tag / untag / cascade", () => {
  it("T5.5 add with links", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const res = await runCommand(
      [
        "add",
        "note",
        "--title",
        "Safekeep auth decision",
        "--link",
        `${testId(1)}:part_of`,
        "--link",
        `${testId(4)}:about`,
      ],
      ctx
    );

    expect(res.exitCode).toBe(0);
    const node = JSON.parse(res.stdout);
    expect(node.links_created).toEqual([
      { dst: testId(1), rel: "part_of" },
      { dst: testId(4), rel: "about" },
    ]);

    const db = openDatabase(ctx.dbPath);
    const edges = db.all(
      "SELECT * FROM edges WHERE src = ? ORDER BY rowid",
      node.id
    );
    db.close();
    expect(edges).toHaveLength(2);
    for (const e of edges) {
      expect(e.origin).toBe("direct");
      expect(e.weight).toBe(1);
    }
  });

  it("T5.6 link to missing node aborts the whole add", async () => {
    const ctx = makeTestContext();
    const res = await runCommand(
      ["add", "note", "--title", "x", "--link", `${testId(99)}:about`],
      ctx
    );

    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stderr).error.code).toBe("NOT_FOUND");
    const db = openDatabase(ctx.dbPath);
    expect(db.get("SELECT COUNT(*) AS n FROM nodes")?.n).toBe(0);
    expect(db.get("SELECT COUNT(*) AS n FROM edges")?.n).toBe(0);
    db.close();
  });

  it("T5.7 unknown rel writes nothing", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    const res = await runCommand(
      ["add", "note", "--title", "x", "--link", `${testId(1)}:friend_of`],
      ctx
    );

    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stderr).error.code).toBe("UNKNOWN_REL");
    const db = openDatabase(ctx.dbPath);
    expect(db.get("SELECT COUNT(*) AS n FROM nodes")?.n).toBe(8);
    db.close();
  });

  it("T7.1 link creates a direct edge with weight", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const res = await runCommand(
      ["link", testId(7), testId(6), "evidences", "--weight", "0.8"],
      ctx
    );

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      src: testId(7),
      dst: testId(6),
      rel: "evidences",
      weight: 0.8,
      origin: "direct",
    });
  });

  it("T7.2 duplicate edge", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["link", testId(7), testId(6), "evidences"], ctx);

    const res = await runCommand(
      ["link", testId(7), testId(6), "evidences"],
      ctx
    );
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stderr).error.code).toBe("DUPLICATE_EDGE");
  });

  it("T7.2b symmetric canonicalization", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    // reverse of a symmetric rel is the same edge
    await runCommand(["link", testId(4), testId(5), "relates_to"], ctx);
    const rev = await runCommand(
      ["link", testId(5), testId(4), "relates_to"],
      ctx
    );
    expect(rev.exitCode).toBe(1);
    expect(JSON.parse(rev.stderr).error.code).toBe("DUPLICATE_EDGE");

    // reverse of a directional rel is a different statement
    await runCommand(["link", testId(4), testId(6), "about"], ctx);
    const dir = await runCommand(["link", testId(6), testId(4), "about"], ctx);
    expect(dir.exitCode).toBe(0);
  });

  it("T7.3 unlink: removes, and missing triple is NOT_FOUND", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const ok = await runCommand(
      ["unlink", testId(2), testId(1), "part_of"],
      ctx
    );
    expect(JSON.parse(ok.stdout).removed).toBe(true);

    const missing = await runCommand(
      ["unlink", testId(2), testId(1), "part_of"],
      ctx
    );
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stderr).error.code).toBe("NOT_FOUND");
  });

  it("T6.5c (completion) link with a soft-deleted endpoint is NOT_FOUND", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["delete", testId(5)], ctx);

    for (const argv of [
      ["link", testId(5), testId(4), "about"],
      ["link", testId(4), testId(5), "about"],
    ]) {
      const res = await runCommand(argv, ctx);
      expect(res.exitCode).toBe(1);
      expect(JSON.parse(res.stderr).error.code).toBe("NOT_FOUND");
    }
  });

  it("T7.4 tag/untag: full tag set, idempotent, FTS-synced", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const tagged = await runCommand(
      ["tag", testId(5), "chargebacks", "disputes"],
      ctx
    );
    expect(JSON.parse(tagged.stdout)).toEqual({
      id: testId(5),
      tags: ["chargebacks", "disputes"],
    });

    // tagging an existing tag is a no-op success
    const again = await runCommand(["tag", testId(5), "chargebacks"], ctx);
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout).tags).toEqual(["chargebacks", "disputes"]);

    // tags are searchable after tagging (FTS re-synced); the match leads
    // and 1-hop expansion adds exactly its neighbor
    const hits = JSON.parse(
      (await runCommand(["query", "chargebacks"], ctx)).stdout
    );
    expect(hits.map((h: { id: string }) => h.id)).toEqual([
      testId(5),
      testId(4),
    ]);

    const untagged = await runCommand(["untag", testId(5), "chargebacks"], ctx);
    expect(JSON.parse(untagged.stdout)).toEqual({
      id: testId(5),
      tags: ["disputes"],
    });
    expect(
      JSON.parse((await runCommand(["query", "chargebacks"], ctx)).stdout)
    ).toEqual([]);
  });

  it("T7.5 archival cascade drops non-terminal part_of tasks, one hop", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    // extra in_progress task part_of the project (<id:9>)
    await runCommand(
      [
        "add",
        "task",
        "--title",
        "Safekeep onboarding docs",
        "--status",
        "in_progress",
        "--link",
        `${testId(1)}:part_of`,
      ],
      ctx
    );

    const res = await runCommand(
      ["update", testId(1), "--status", "archived"],
      ctx
    );

    expect(res.exitCode).toBe(0);
    const node = JSON.parse(res.stdout);
    expect(node.status).toBe("archived");
    expect(node.cascaded).toEqual([
      { id: testId(2), from: "open", to: "dropped" },
      { id: testId(9), from: "in_progress", to: "dropped" },
    ]);

    // terminal task untouched; cascaded tasks dropped
    const done = JSON.parse((await runCommand(["get", testId(3)], ctx)).stdout);
    expect(done.status).toBe("done");
    const dropped = JSON.parse(
      (await runCommand(["get", testId(2)], ctx)).stdout
    );
    expect(dropped.status).toBe("dropped");
  });
});
