import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { addNode as add, makeTestContext, reportJson } from "./testing";
import type { Context } from "./context";

const report = (ctx: Context, args: string[] = []) =>
  reportJson(ctx, "tasks", args);

function addTask(
  ctx: Context,
  title: string,
  opts: {
    status?: string;
    payload?: Record<string, unknown>;
    link?: string;
  } = {}
) {
  const args = ["task", "--title", title];
  if (opts.status) args.push("--status", opts.status);
  if (opts.payload) args.push("--payload", JSON.stringify(opts.payload));
  if (opts.link) args.push("--link", opts.link);
  return add(ctx, args);
}

describe("Item 16 — report tasks (Phase 3)", () => {
  it("T16.1 only open and in_progress tasks appear, with status/due_at/priority fields", async () => {
    const ctx = makeTestContext();
    const open = await addTask(ctx, "Write invoice", {
      payload: { due_at: "2026-02-01", priority: "high" },
    });
    const inProgress = await addTask(ctx, "Ship v1", {
      status: "in_progress",
    });
    await addTask(ctx, "Old chore", { status: "done" });
    await addTask(ctx, "Abandoned idea", { status: "dropped" });

    const out = await report(ctx);
    expect(out.report).toBe("tasks");
    expect(out.project).toBeNull();
    const tasks = out.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id).sort()).toEqual(
      [open.id, inProgress.id].sort()
    );
    expect(tasks.find((t) => t.id === open.id)).toMatchObject({
      title: "Write invoice",
      status: "open",
      due_at: "2026-02-01",
      priority: "high",
    });
    expect(tasks.find((t) => t.id === inProgress.id)).toMatchObject({
      status: "in_progress",
      due_at: null,
      priority: null,
    });
  });

  it("T16.2 ordered by due_at ascending (nulls last), then priority high>med>low (missing last)", async () => {
    const ctx = makeTestContext();
    const marchLow = await addTask(ctx, "March low", {
      payload: { due_at: "2026-03-01", priority: "low" },
    });
    const febMed = await addTask(ctx, "Feb med", {
      payload: { due_at: "2026-02-01", priority: "med" },
    });
    const febHigh = await addTask(ctx, "Feb high", {
      payload: { due_at: "2026-02-01", priority: "high" },
    });
    const undatedHigh = await addTask(ctx, "Undated high", {
      payload: { priority: "high" },
    });
    const undatedNone = await addTask(ctx, "Undated none");

    const out = await report(ctx);
    expect((out.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual([
      febHigh.id,
      febMed.id,
      marchLow.id,
      undatedHigh.id,
      undatedNone.id,
    ]);
  });

  it("T16.3 --project scopes via part_of edges, accepts id or exact title, rows carry projects", async () => {
    const ctx = makeTestContext();
    const safekeep = await add(ctx, [
      "project",
      "--title",
      "Safekeep Recovery App",
    ]);
    const nook = await add(ctx, ["project", "--title", "Nook KB"]);
    const inSafekeep = await addTask(ctx, "Ship Safekeep v1", {
      link: `${safekeep.id}:part_of`,
    });
    await addTask(ctx, "Wire nook reports", { link: `${nook.id}:part_of` });
    const loose = await addTask(ctx, "Renew passport");

    const byId = await report(ctx, ["--project", safekeep.id]);
    expect(byId.project).toEqual({
      id: safekeep.id,
      title: "Safekeep Recovery App",
    });
    const scoped = byId.tasks as Array<Record<string, unknown>>;
    expect(scoped.map((t) => t.id)).toEqual([inSafekeep.id]);
    expect(scoped[0]!.projects).toEqual([
      { id: safekeep.id, title: "Safekeep Recovery App" },
    ]);

    const byTitle = await report(ctx, ["--project", "safekeep recovery app"]);
    expect((byTitle.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual([
      inSafekeep.id,
    ]);

    const all = await report(ctx);
    expect((all.tasks as unknown[]).length).toBe(3);
    const looseRow = (all.tasks as Array<Record<string, unknown>>).find(
      (t) => t.id === loose.id
    );
    expect(looseRow!.projects).toEqual([]);
  });

  it("T16.4 unknown project NOT_FOUND; ambiguous title INVALID_ARGS", async () => {
    const ctx = makeTestContext();
    await add(ctx, ["project", "--title", "Duplicate"]);
    await add(ctx, ["project", "--title", "duplicate"]);

    const missing = await runCommand(
      ["report", "tasks", "--project", "no-such-project"],
      ctx
    );
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stderr).error.code).toBe("NOT_FOUND");

    const ambiguous = await runCommand(
      ["report", "tasks", "--project", "DUPLICATE"],
      ctx
    );
    expect(ambiguous.exitCode).toBe(1);
    expect(JSON.parse(ambiguous.stderr).error.code).toBe("INVALID_ARGS");
  });

  it("T16.5 tasks dropped by the archival cascade vanish; an archived project still resolves", async () => {
    const ctx = makeTestContext();
    const project = await add(ctx, ["project", "--title", "Sunset project"]);
    await addTask(ctx, "Open work", { link: `${project.id}:part_of` });
    await addTask(ctx, "Started work", {
      status: "in_progress",
      link: `${project.id}:part_of`,
    });
    const unrelated = await addTask(ctx, "Unrelated errand");

    const archive = await runCommand(
      ["update", project.id, "--status", "archived"],
      ctx
    );
    expect(archive.exitCode).toBe(0);

    const all = await report(ctx);
    expect((all.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual([
      unrelated.id,
    ]);

    // closed nodes stay visible to reports: the archived project resolves, scope is just empty
    const scoped = await report(ctx, ["--project", project.id]);
    expect(scoped.tasks).toEqual([]);
  });

  it("T16.6 soft-deleted tasks excluded; a deleted project no longer resolves or appears on rows", async () => {
    const ctx = makeTestContext();
    const project = await add(ctx, ["project", "--title", "Doomed project"]);
    const task = await addTask(ctx, "Surviving task", {
      link: `${project.id}:part_of`,
    });
    const goner = await addTask(ctx, "Deleted task");
    await runCommand(["delete", goner.id], ctx);
    await runCommand(["delete", project.id], ctx);

    const out = await report(ctx);
    const rows = out.tasks as Array<Record<string, unknown>>;
    expect(rows.map((t) => t.id)).toEqual([task.id]);
    expect(rows[0]!.projects).toEqual([]); // deleted project gone from rows

    const res = await runCommand(
      ["report", "tasks", "--project", project.id],
      ctx
    );
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stderr).error.code).toBe("NOT_FOUND");
  });

  it("T16.7 --human renders markdown", async () => {
    const ctx = makeTestContext();
    const project = await add(ctx, ["project", "--title", "Safekeep"]);
    await addTask(ctx, "Ship v1", {
      status: "in_progress",
      payload: { due_at: "2026-02-01", priority: "high" },
      link: `${project.id}:part_of`,
    });

    const res = await runCommand(
      ["report", "tasks", "--project", "Safekeep", "--human"],
      ctx
    );
    expect(res.exitCode).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow(); // markdown, not JSON
    expect(res.stdout).toContain("# Tasks");
    expect(res.stdout).toContain("Safekeep");
    expect(res.stdout).toContain("Ship v1");
    expect(res.stdout).toContain("2026-02-01");
    expect(res.stdout).toContain("high");
    expect(res.stdout).toContain("in_progress");
  });

  it("T16.8 priority breaks ties within a calendar date even when due_at carries times", async () => {
    const ctx = makeTestContext();
    const eveningHigh = await addTask(ctx, "Evening high", {
      payload: { due_at: "2026-02-01T17:00", priority: "high" },
    });
    const morningLow = await addTask(ctx, "Morning low", {
      payload: { due_at: "2026-02-01T08:00", priority: "low" },
    });
    const nextDay = await addTask(ctx, "Next day", {
      payload: { due_at: "2026-02-02", priority: "high" },
    });

    const out = await report(ctx);
    expect((out.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual([
      eveningHigh.id, // same date as morningLow: priority wins, not time of day
      morningLow.id,
      nextDay.id,
    ]);
  });
});
