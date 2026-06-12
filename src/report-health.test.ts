import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCommand } from "./run-command";
import { addNode as add, makeTestContext, reportJson } from "./testing";
import type { Context } from "./context";

const report = (ctx: Context, args: string[] = []) =>
  reportJson(ctx, "health-correlations", args);

function addMeal(
  ctx: Context,
  title: string,
  items: string[],
  at: string,
  tags: string[] = []
) {
  const args = [
    "meal",
    "--title",
    title,
    "--payload",
    JSON.stringify({ items }),
    "--occurred-at",
    at,
  ];
  for (const t of tags) args.push("--tag", t);
  return add(ctx, args);
}

function addSymptom(ctx: Context, name: string, at: string) {
  return add(ctx, [
    "symptom",
    "--title",
    name,
    "--payload",
    JSON.stringify({ name }),
    "--occurred-at",
    at,
  ]);
}

describe("Item 17 — report health-correlations (Phase 3)", () => {
  it("T17.1 same-day symptom×meal-item co-occurrence counts, labeled not-causation", async () => {
    const ctx = makeTestContext();
    await addMeal(
      ctx,
      "Breakfast",
      ["oatmeal", "coffee"],
      "2026-01-05T08:00:00.000Z"
    );
    await addMeal(ctx, "Lunch", ["coffee"], "2026-01-05T12:00:00.000Z");
    await addSymptom(ctx, "headache", "2026-01-05T15:00:00.000Z");

    const out = await report(ctx);
    expect(out.report).toBe("health-correlations");
    expect(out.since).toBeNull();
    expect(out.windows).toEqual(["same-day", "next-day"]);
    expect(String(out.note)).toMatch(/co-occurrence/i);
    expect(String(out.note)).toMatch(/not causation/i);

    const correlations = out.correlations as Array<Record<string, unknown>>;
    // coffee co-occurs twice (two meals, one symptom day), oatmeal once
    expect(correlations[0]).toMatchObject({
      symptom: "headache",
      exposure: "coffee",
      via: "item",
      counts: { "same-day": 2 },
      total: 2,
    });
    expect(correlations[1]).toMatchObject({
      symptom: "headache",
      exposure: "oatmeal",
      via: "item",
      counts: { "same-day": 1 },
      total: 1,
    });
    expect(correlations).toHaveLength(2);
  });

  it("T17.2 next-day counts symptom AFTER meal only; day-before and 2-days-out never count", async () => {
    const ctx = makeTestContext();
    await addMeal(ctx, "Dinner", ["shellfish"], "2026-01-10T19:00:00.000Z");
    await addSymptom(ctx, "hives", "2026-01-11T08:00:00.000Z"); // next-day: counts
    await addSymptom(ctx, "fatigue", "2026-01-09T08:00:00.000Z"); // day BEFORE: never
    await addSymptom(ctx, "nausea", "2026-01-12T08:00:00.000Z"); // 2 days out: never

    const out = await report(ctx);
    const correlations = out.correlations as Array<Record<string, unknown>>;
    expect(correlations).toEqual([
      {
        symptom: "hives",
        exposure: "shellfish",
        via: "item",
        counts: { "next-day": 1 },
        total: 1,
      },
    ]);
  });

  it("T17.3 suggest.windows drives the report: same-day-only config drops next-day pairs", async () => {
    const base = makeTestContext();
    const configPath = join(dirname(base.dbPath), "memory.jsonc");
    writeFileSync(configPath, '{ "suggest.windows": ["same-day"] }');
    const ctx = { ...base, configPath };

    await addMeal(ctx, "Dinner", ["shellfish"], "2026-01-10T19:00:00.000Z");
    await addSymptom(ctx, "hives", "2026-01-11T08:00:00.000Z"); // next-day
    await addSymptom(ctx, "itching", "2026-01-10T22:00:00.000Z"); // same-day

    const out = await report(ctx);
    expect(out.windows).toEqual(["same-day"]);
    const correlations = out.correlations as Array<Record<string, unknown>>;
    expect(correlations).toEqual([
      {
        symptom: "itching",
        exposure: "shellfish",
        via: "item",
        counts: { "same-day": 1 },
        total: 1,
      },
    ]);
  });

  it("T17.4 meal tags correlate alongside items, distinguished by via", async () => {
    const ctx = makeTestContext();
    await addMeal(ctx, "Latte", ["latte"], "2026-01-05T08:00:00.000Z", [
      "food/dairy",
    ]);
    await addSymptom(ctx, "bloating", "2026-01-05T13:00:00.000Z");

    const out = await report(ctx);
    const correlations = out.correlations as Array<Record<string, unknown>>;
    expect(correlations).toContainEqual({
      symptom: "bloating",
      exposure: "food/dairy",
      via: "tag",
      counts: { "same-day": 1 },
      total: 1,
    });
    expect(correlations).toContainEqual({
      symptom: "bloating",
      exposure: "latte",
      via: "item",
      counts: { "same-day": 1 },
      total: 1,
    });
  });

  it("T17.5 --since drops pairs before the cutoff and rejects malformed values", async () => {
    const ctx = makeTestContext();
    await addMeal(ctx, "Old meal", ["coffee"], "2026-01-05T08:00:00.000Z");
    await addSymptom(ctx, "headache", "2026-01-05T13:00:00.000Z");
    await addMeal(ctx, "New meal", ["coffee"], "2026-03-05T08:00:00.000Z");
    await addSymptom(ctx, "headache", "2026-03-05T13:00:00.000Z");
    // straddles the cutoff: the meal exposure itself predates --since
    await addMeal(ctx, "Boundary meal", ["wine"], "2026-01-31T20:00:00.000Z");
    await addSymptom(ctx, "headache", "2026-02-01T08:00:00.000Z");

    const out = await report(ctx, ["--since", "2026-02-01"]);
    expect(out.since).toBe("2026-02-01");
    expect(out.correlations).toEqual([
      {
        symptom: "headache",
        exposure: "coffee",
        via: "item",
        counts: { "same-day": 1 },
        total: 1,
      },
    ]);

    const bad = await runCommand(
      ["report", "health-correlations", "--since", "yesterday"],
      ctx
    );
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stderr).error.code).toBe("INVALID_ARGS");
  });

  it("T17.6 soft-deleted meals and symptoms contribute no pairs", async () => {
    const ctx = makeTestContext();
    const meal = await addMeal(
      ctx,
      "Deleted meal",
      ["coffee"],
      "2026-01-05T08:00:00.000Z"
    );
    const symptom = await addSymptom(
      ctx,
      "headache",
      "2026-01-05T13:00:00.000Z"
    );
    await runCommand(["delete", meal.id], ctx);

    const afterMealDelete = await report(ctx);
    expect(afterMealDelete.correlations).toEqual([]);

    await addMeal(ctx, "Live meal", ["coffee"], "2026-01-05T09:00:00.000Z");
    await runCommand(["delete", symptom.id], ctx);
    const afterSymptomDelete = await report(ctx);
    expect(afterSymptomDelete.correlations).toEqual([]);
  });

  it("T17.7 --human renders markdown carrying the not-causation label", async () => {
    const ctx = makeTestContext();
    await addMeal(ctx, "Breakfast", ["coffee"], "2026-01-05T08:00:00.000Z");
    await addSymptom(ctx, "headache", "2026-01-05T13:00:00.000Z");

    const res = await runCommand(
      ["report", "health-correlations", "--human"],
      ctx
    );
    expect(res.exitCode).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow(); // markdown, not JSON
    expect(res.stdout).toContain("# Health correlations");
    expect(res.stdout).toMatch(/not causation/i);
    expect(res.stdout).toContain("headache");
    expect(res.stdout).toContain("coffee");
    expect(res.stdout).toContain("same-day");
  });
});
