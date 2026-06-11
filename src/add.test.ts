import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { openDatabase } from "./sqlite";
import { makeTestContext } from "./testing";

describe("Item 5 — add (capture & find slice)", () => {
  it("T5.1 minimal add", async () => {
    const ctx = makeTestContext();
    const res = await runCommand(
      ["add", "note", "--title", "Bun macros are compile-time"],
      ctx
    );

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      id: "TESTID00000000000000000001",
      kind: "note",
      title: "Bun macros are compile-time",
      body_length: 0,
      payload: {},
      status: null,
      tags: [],
      occurred_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      deleted_at: null,
      links_created: [],
      unresolved_links: [],
      chunks_created: 0,
    });
  });

  it("T5.2 full add", async () => {
    const ctx = makeTestContext();
    const res = await runCommand(
      [
        "add",
        "task",
        "--title",
        "Renew passport",
        "--payload",
        '{"due_at":"2026-03-01","priority":"med"}',
        "--tag",
        "admin",
        "--tag",
        "personal",
        "--status",
        "open",
        "--occurred-at",
        "2026-01-01T09:00:00.000Z",
      ],
      ctx
    );

    expect(res.exitCode).toBe(0);
    const node = JSON.parse(res.stdout);
    expect(node).toMatchObject({
      kind: "task",
      title: "Renew passport",
      payload: { due_at: "2026-03-01", priority: "med" },
      status: "open",
      tags: ["admin", "personal"],
      occurred_at: "2026-01-01T09:00:00.000Z",
    });

    const db = openDatabase(ctx.dbPath);
    expect(db.get("SELECT due_at FROM nodes WHERE id = ?", node.id)).toEqual({
      due_at: "2026-03-01",
    });
    db.close();
  });

  it("T5.3 payload validation failure writes nothing", async () => {
    const ctx = makeTestContext();
    const res = await runCommand(
      [
        "add",
        "transaction",
        "--title",
        "Coffee",
        "--payload",
        '{"amount":"four","currency":"CAD","direction":"expense"}',
      ],
      ctx
    );

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    const err = JSON.parse(res.stderr).error;
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toContain("amount");

    const db = openDatabase(ctx.dbPath);
    expect(db.get("SELECT COUNT(*) AS n FROM nodes")?.n).toBe(0);
    db.close();
  });

  it("T5.4 invalid status for kind", async () => {
    const bad = await runCommand(
      ["add", "task", "--title", "x", "--status", "someday"],
      makeTestContext()
    );
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stderr).error.code).toBe("INVALID_STATUS");

    const statusless = await runCommand(
      ["add", "note", "--title", "x", "--status", "open"],
      makeTestContext()
    );
    expect(statusless.exitCode).toBe(1);
    expect(JSON.parse(statusless.stderr).error.code).toBe("INVALID_STATUS");
  });

  it("T5.4b default status applied per kind", async () => {
    const ctx = makeTestContext();
    const task = JSON.parse(
      (await runCommand(["add", "task", "--title", "Renew passport"], ctx))
        .stdout
    );
    expect(task.status).toBe("open");

    const event = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "event",
            "--title",
            "Dentist",
            "--payload",
            '{"starts_at":"2026-01-20T15:00:00.000Z"}',
          ],
          ctx
        )
      ).stdout
    );
    expect(event.status).toBe("planned");
  });

  it("T5.8 event timestamp convention: occurred_at mirrors starts_at", async () => {
    const ctx = makeTestContext();
    const event = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "event",
            "--title",
            "Dentist",
            "--payload",
            '{"starts_at":"2026-01-20T15:00:00.000Z"}',
          ],
          ctx
        )
      ).stdout
    );
    expect(event.occurred_at).toBe("2026-01-20T15:00:00.000Z");
  });

  it("T5.8b mirror is an invariant: explicit --occurred-at rejected, reschedule follows", async () => {
    const ctx = makeTestContext();

    const explicit = await runCommand(
      [
        "add",
        "event",
        "--title",
        "Dentist",
        "--occurred-at",
        "2026-01-19T00:00:00.000Z",
        "--payload",
        '{"starts_at":"2026-01-20T15:00:00.000Z"}',
      ],
      ctx
    );
    expect(explicit.exitCode).toBe(1);
    expect(JSON.parse(explicit.stderr).error.code).toBe("INVALID_ARGS");

    const { id } = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "event",
            "--title",
            "Dentist",
            "--payload",
            '{"starts_at":"2026-01-20T15:00:00.000Z"}',
          ],
          ctx
        )
      ).stdout
    );

    // rescheduling via payload-merge moves occurred_at with it
    const moved = JSON.parse(
      (
        await runCommand(
          [
            "update",
            id,
            "--payload-merge",
            '{"starts_at":"2026-01-21T15:00:00.000Z"}',
          ],
          ctx
        )
      ).stdout
    );
    expect(moved.occurred_at).toBe("2026-01-21T15:00:00.000Z");

    // explicit --occurred-at on update is rejected for events too
    const explicitUpdate = await runCommand(
      ["update", id, "--occurred-at", "2026-01-22T00:00:00.000Z"],
      ctx
    );
    expect(explicitUpdate.exitCode).toBe(1);
    expect(JSON.parse(explicitUpdate.stderr).error.code).toBe("INVALID_ARGS");
  });
});
