import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { makeTestContext } from "./testing";

const ALL_KINDS = [
  "note",
  "project",
  "doc",
  "task",
  "source",
  "chunk",
  "insight",
  "person",
  "event",
  "idea",
  "list",
  "list_item",
  "meal",
  "symptom",
  "visit",
  "lab_result",
  "transaction",
  "subscription",
  "mood",
  "sleep",
  "activity",
  "measurement",
];

describe("Item 3 — kind registry", () => {
  it("T3.1 list kinds", async () => {
    const res = await runCommand(["kinds"], makeTestContext());

    expect(res.exitCode).toBe(0);
    const kinds = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
    expect(kinds.map((k) => k.kind).sort()).toEqual([...ALL_KINDS].sort());
    for (const k of kinds) {
      expect(k.statuses === null || Array.isArray(k.statuses)).toBe(true);
      expect("default_status" in k).toBe(true);
      // payload_schema is JSON Schema: an object-typed schema per SPEC §4
      expect(k.payload_schema).toMatchObject({ type: "object" });
    }
  });

  it("T3.2 single kind", async () => {
    const task = JSON.parse(
      (await runCommand(["kinds", "task"], makeTestContext())).stdout
    );
    expect(task.statuses).toEqual(["open", "in_progress", "done", "dropped"]);
    expect(task.default_status).toBe("open");
    expect(Object.keys(task.payload_schema.properties)).toEqual(
      expect.arrayContaining(["due_at", "priority"])
    );

    const note = JSON.parse(
      (await runCommand(["kinds", "note"], makeTestContext())).stdout
    );
    expect(note.statuses).toBeNull();
    expect(note.default_status).toBeNull();
  });

  it("T3.3 unknown kind", async () => {
    const res = await runCommand(["kinds", "wizard"], makeTestContext());

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr).error.code).toBe("UNKNOWN_KIND");
  });
});
