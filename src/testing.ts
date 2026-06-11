import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "./context";
import { openStore } from "./store";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function bareContext(overrides: Partial<Context>): Context {
  const dir = mkdtempSync(join(tmpdir(), "mem-test-"));
  let tick = 0;
  let idCounter = 0;
  return {
    dbPath: join(dir, "memory.db"),
    clock: () => new Date(T0 + tick++ * 1000),
    generateId: () => `TESTID${String(++idCounter).padStart(20, "0")}`,
    ...overrides,
  };
}

/**
 * Deterministic Context per TDD §1: temp dbPath, clock starting
 * 2026-01-01T00:00:00.000Z advancing +1s per call, sequential TESTID ulids.
 * The database is pre-migrated as fixture setup (with a constant setup
 * clock) so the first write in a test lands at T+0.
 */
export function makeTestContext(overrides: Partial<Context> = {}): Context {
  const ctx = bareContext(overrides);
  openStore(ctx.dbPath, () => new Date(T0)).close();
  return ctx;
}

/** No pre-migration: for tests exercising first-run behavior (T2.x). */
export function makeUnmigratedContext(
  overrides: Partial<Context> = {}
): Context {
  return bareContext(overrides);
}

/**
 * Standard graph fixture (TDD §3): 8 nodes, 3 edges, 3 tags — everything
 * through the real add command, edges via --link.
 */
export async function seedStandardGraph(ctx: Context): Promise<void> {
  const { runCommand } = await import("./run-command");
  const add = async (args: string[]) => {
    const res = await runCommand(["add", ...args], ctx);
    if (res.exitCode !== 0) throw new Error(`seed failed: ${res.stderr}`);
  };

  await add([
    "project",
    "--title",
    "Safekeep Recovery App",
    "--status",
    "active",
    "--tag",
    "client/safekeep",
  ]); // <id:1>
  await add([
    "task",
    "--title",
    "Ship Safekeep v1",
    "--status",
    "open",
    "--payload",
    '{"due_at":"2026-02-01","priority":"high"}',
    "--link",
    `${testId(1)}:part_of`,
  ]); // <id:2>
  await add([
    "task",
    "--title",
    "Invoice Safekeep milestone 1",
    "--status",
    "done",
    "--link",
    `${testId(1)}:part_of`,
  ]); // <id:3>
  await add([
    "person",
    "--title",
    "Melinda",
    "--payload",
    '{"relation":"client"}',
  ]); // <id:4>
  await add([
    "note",
    "--title",
    "Square delayed capture gotchas",
    "--body",
    "the payment capture window closes after seven days",
    "--link",
    `${testId(4)}:about`,
  ]); // <id:5>
  await add([
    "meal",
    "--title",
    "Breakfast",
    "--payload",
    '{"items":["oatmeal","coffee"]}',
    "--occurred-at",
    "2026-01-01T08:00:00.000Z",
    "--tag",
    "health/food",
  ]); // <id:6>
  await add([
    "symptom",
    "--title",
    "Headache",
    "--payload",
    '{"name":"headache","severity":3}',
    "--occurred-at",
    "2026-01-01T14:00:00.000Z",
    "--tag",
    "health/symptom",
  ]); // <id:7>
  await add([
    "transaction",
    "--title",
    "Safekeep milestone payment",
    "--payload",
    '{"amount":2500,"currency":"CAD","direction":"income","category":"client-work"}',
  ]); // <id:8>
}

/** `<id:n>` as written in TDD §1. */
export function testId(n: number): string {
  return `TESTID${String(n).padStart(20, "0")}`;
}
