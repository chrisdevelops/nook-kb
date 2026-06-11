import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { makeTestContext } from "./testing";

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
});
