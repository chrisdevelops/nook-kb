import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { makeTestContext } from "./testing";

describe("Item 19 — measurement kind (generic scalar readings)", () => {
  it("T19.1 measurement round-trips: metric, value, unit all required", async () => {
    const ctx = makeTestContext();
    const res = await runCommand(
      [
        "add",
        "measurement",
        "--title",
        "Morning water",
        "--payload",
        '{"metric":"water","value":500,"unit":"ml"}',
        "--occurred-at",
        "2026-01-05T08:00:00.000Z",
      ],
      ctx
    );

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      kind: "measurement",
      payload: { metric: "water", value: 500, unit: "ml" },
      status: null,
      occurred_at: "2026-01-05T08:00:00.000Z",
    });

    const kind = JSON.parse(
      (await runCommand(["kinds", "measurement"], ctx)).stdout
    );
    expect(kind.statuses).toBeNull();
    expect(kind.default_status).toBeNull();
    expect([...kind.payload_schema.required].sort()).toEqual([
      "metric",
      "unit",
      "value",
    ]);
  });

  it("T19.2 unitless readings rejected; statusless", async () => {
    const noUnit = await runCommand(
      [
        "add",
        "measurement",
        "--title",
        "x",
        "--payload",
        '{"metric":"water","value":500}',
      ],
      makeTestContext()
    );
    expect(noUnit.exitCode).toBe(1);
    expect(noUnit.stdout).toBe("");
    const err = JSON.parse(noUnit.stderr).error;
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toContain("unit");

    const withStatus = await runCommand(
      [
        "add",
        "measurement",
        "--title",
        "x",
        "--payload",
        '{"metric":"water","value":500,"unit":"ml"}',
        "--status",
        "active",
      ],
      makeTestContext()
    );
    expect(withStatus.exitCode).toBe(1);
    expect(JSON.parse(withStatus.stderr).error.code).toBe("INVALID_STATUS");
  });

  it("T19.3 measurement is NOT a health kind: no temporal pairs, no med-adjacency", async () => {
    const ctx = makeTestContext();
    const add = async (args: string[]) =>
      JSON.parse((await runCommand(["add", ...args], ctx)).stdout);
    const meal = await add([
      "meal",
      "--title",
      "Lunch",
      "--payload",
      '{"items":["soup"]}',
      "--occurred-at",
      "2026-01-05T12:00:00.000Z",
    ]);
    const water = await add([
      "measurement",
      "--title",
      "Water",
      "--payload",
      '{"metric":"water","value":500,"unit":"ml"}',
      "--occurred-at",
      "2026-01-05T12:30:00.000Z",
    ]);

    // same-day, different kinds — still never proposed: not in the health set
    await runCommand(["suggest"], ctx);
    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string }>;
    expect(pending.map((s) => `${s.src}|${s.dst}`)).not.toContain(
      `${meal.id}|${water.id}`
    );

    // a note linked to a measurement is not med-adjacent
    const note = await add([
      "note",
      "--title",
      "Trying to drink more",
      "--link",
      `${water.id}:about`,
    ]);
    const out = JSON.parse(
      (await runCommand(["report", "medical-history"], ctx)).stdout
    );
    const notes = out.notes as Array<{ id: string }>;
    expect(notes.map((n) => n.id)).not.toContain(note.id);
  });
});
