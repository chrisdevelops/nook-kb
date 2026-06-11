import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "./context";

/**
 * Deterministic Context per TDD §1: temp dbPath, clock starting
 * 2026-01-01T00:00:00.000Z advancing +1s per call, sequential TESTID ulids.
 */
export function makeTestContext(overrides: Partial<Context> = {}): Context {
  const dir = mkdtempSync(join(tmpdir(), "mem-test-"));
  let tick = 0;
  let idCounter = 0;
  return {
    dbPath: join(dir, "memory.db"),
    clock: () =>
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + tick++ * 1000),
    generateId: () => `TESTID${String(++idCounter).padStart(20, "0")}`,
    ...overrides,
  };
}
