import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { openDatabase } from "./sqlite";
import { makeTestContext } from "./testing";

const para = (n: number) =>
  `Paragraph ${n} of the episode covers a topic in some depth, wandering through examples and asides the way podcast conversations do.`;

// ~12k tokens (chars/4): ~370 paragraphs of ~130 chars
const LONG_BODY = Array.from({ length: 370 }, (_, i) => para(i + 1)).join(
  "\n\n"
);
const SHORT_BODY = Array.from({ length: 15 }, (_, i) => para(i + 1)).join(
  "\n\n"
);

describe("Item 5 — source auto-chunking", () => {
  it("T5.9 long source auto-chunks", async () => {
    const ctx = makeTestContext({ stdin: LONG_BODY });
    const res = await runCommand(
      [
        "add",
        "source",
        "--title",
        "Pod ep 41",
        "--payload",
        '{"source_type":"podcast"}',
        "--body-stdin",
      ],
      ctx
    );

    expect(res.exitCode).toBe(0);
    const source = JSON.parse(res.stdout);
    expect(source.chunks_created).toBeGreaterThanOrEqual(3);
    expect(source.body_length).toBe(LONG_BODY.length); // source keeps full body

    const db = openDatabase(ctx.dbPath);
    const chunks = db.all(
      `SELECT n.id, n.title, n.body, n.payload FROM nodes n WHERE n.kind = 'chunk' ORDER BY json_extract(n.payload, '$.position')`
    );
    expect(chunks).toHaveLength(source.chunks_created);
    chunks.forEach((c, i) => {
      expect(JSON.parse(c.payload as string).position).toBe(i + 1);
      expect(c.title).toBe(`Pod ep 41 (${i + 1}/${chunks.length})`);
    });
    const edges = db.all(
      "SELECT src, rel, origin FROM edges WHERE dst = ?",
      source.id
    );
    db.close();
    expect(edges).toHaveLength(chunks.length);
    for (const e of edges) expect(e.rel).toBe("part_of");
  });

  it("T5.10 short source does not chunk", async () => {
    const ctx = makeTestContext({ stdin: SHORT_BODY });
    const res = await runCommand(
      [
        "add",
        "source",
        "--title",
        "Quick read",
        "--payload",
        '{"source_type":"article"}',
        "--body-stdin",
      ],
      ctx
    );

    const source = JSON.parse(res.stdout);
    expect(source.chunks_created).toBe(0);
    const db = openDatabase(ctx.dbPath);
    expect(
      db.get("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'chunk'")?.n
    ).toBe(0);
    db.close();
  });

  it("chunk dedup: query returns one best chunk per document, not the source", async () => {
    const ctx = makeTestContext({ stdin: LONG_BODY });
    const added = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "source",
            "--title",
            "Pod ep 41",
            "--payload",
            '{"source_type":"podcast"}',
            "--body-stdin",
          ],
          ctx
        )
      ).stdout
    );
    expect(added.chunks_created).toBeGreaterThan(1);

    // "wandering" appears in every paragraph → source body AND every chunk match
    const hits = JSON.parse(
      (await runCommand(["query", "wandering"], ctx)).stdout
    ) as Array<{ id: string; kind: string }>;

    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("chunk");
    expect(hits[0]!.id).not.toBe(added.id);
  });
});
