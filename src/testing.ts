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
