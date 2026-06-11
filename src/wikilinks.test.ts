import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { openDatabase } from "./sqlite";
import { makeTestContext, seedStandardGraph, testId } from "./testing";
import { resolveWikilinks } from "./wikilinks";

describe("wikilink resolver — pure function contract (TDD §5.2)", () => {
  it("T-W.1 [[<exact ulid>]] → edge to that id", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const db = openDatabase(ctx.dbPath);
    const res = resolveWikilinks(`Talked to [[${testId(4)}]] about it.`, db);
    db.close();

    expect(res).toEqual({ edges: [{ dst: testId(4) }], unresolved: [] });
  });

  it("T-W.2 [[Exact Title]] → edge when exactly one live node matches, case-insensitively", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const db = openDatabase(ctx.dbPath);
    const res = resolveWikilinks(
      "Per [[square delayed CAPTURE gotchas]], wait for settlement.",
      db
    );
    db.close();

    expect(res).toEqual({ edges: [{ dst: testId(5) }], unresolved: [] });
  });

  it("T-W.3 ambiguous title (two nodes) → no edge, title in unresolved", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    // a second live node titled like <id:4>, differing only in case
    await runCommand(["add", "person", "--title", "melinda"], ctx);

    const db = openDatabase(ctx.dbPath);
    const res = resolveWikilinks("Ping [[Melinda]] tomorrow.", db);
    db.close();

    expect(res).toEqual({ edges: [], unresolved: ["Melinda"] });
  });

  it("T-W.5 links to soft-deleted nodes → unresolved", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    await runCommand(["delete", testId(5)], ctx);

    const db = openDatabase(ctx.dbPath);
    const res = resolveWikilinks(
      `By id [[${testId(5)}]] and by title [[Square delayed capture gotchas]].`,
      db
    );
    db.close();

    expect(res).toEqual({
      edges: [],
      unresolved: [testId(5), "Square delayed capture gotchas"],
    });
  });
});

describe("wikilinks wired through add and update (TDD §5.2)", () => {
  it("T-W.4 unknown title → in unresolved_links; add still succeeds", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);

    const res = await runCommand(
      [
        "add",
        "note",
        "--title",
        "Call notes",
        "--body",
        "Spoke to [[Melinda]] re [[No Such Node]].",
      ],
      ctx
    );

    expect(res.exitCode).toBe(0);
    const node = JSON.parse(res.stdout);
    expect(node.unresolved_links).toEqual(["No Such Node"]);
    expect(node.links_created).toEqual([{ dst: testId(4), rel: "references" }]);

    const db = openDatabase(ctx.dbPath);
    const edges = db.all(
      "SELECT dst, rel, origin FROM edges WHERE src = ?",
      node.id
    );
    db.close();
    expect(edges).toEqual([
      { dst: testId(4), rel: "references", origin: "wikilink" },
    ]);
  });

  it("T-W.6 body-update diff is origin-scoped", async () => {
    const ctx = makeTestContext();
    await seedStandardGraph(ctx);
    // A = <id:4> via wikilink; B = <id:5> via a direct references edge
    const added = await runCommand(
      ["add", "note", "--title", "Call notes", "--body", "Ask [[Melinda]]."],
      ctx
    );
    const id = JSON.parse(added.stdout).id;
    await runCommand(["link", id, testId(5), "references"], ctx);

    // drop [[A]], add [[B]] (duplicates the direct edge) and [[C]] (new)
    const res = await runCommand(
      [
        "update",
        id,
        "--body",
        "Per [[Square delayed capture gotchas]] under [[Safekeep Recovery App]].",
      ],
      ctx
    );

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).unresolved_links).toEqual([]);

    const db = openDatabase(ctx.dbPath);
    const edges = db.all(
      "SELECT dst, rel, origin FROM edges WHERE src = ? ORDER BY rowid",
      id
    );
    db.close();
    expect(edges).toEqual([
      // existing direct edge to B survives untouched, not duplicated
      { dst: testId(5), rel: "references", origin: "direct" },
      // genuinely new target C gains a wikilink edge; A's edge is gone
      { dst: testId(1), rel: "references", origin: "wikilink" },
    ]);
  });

  it("T-W.7 unresolved links are not persisted: no forward references", async () => {
    const ctx = makeTestContext();
    const added = await runCommand(
      ["add", "note", "--title", "Ideas", "--body", "Try [[Future Thing]]."],
      ctx
    );
    const node = JSON.parse(added.stdout);
    expect(node.unresolved_links).toEqual(["Future Thing"]);

    // creating the target later does not materialize the edge (SPEC §5.1)
    await runCommand(["add", "note", "--title", "Future Thing"], ctx);

    const db = openDatabase(ctx.dbPath);
    expect(db.get("SELECT COUNT(*) AS n FROM edges")?.n).toBe(0);
    db.close();
  });
});
