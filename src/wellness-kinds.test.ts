import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { makeTestContext } from "./testing";

describe("Item 18 — wellness kinds (mood / sleep / activity)", () => {
  it("T18.1 mood round-trips: valence rating + labels, statusless", async () => {
    const ctx = makeTestContext();
    const res = await runCommand(
      [
        "add",
        "mood",
        "--title",
        "Low afternoon",
        "--payload",
        '{"rating":2,"labels":["anxious","irritated"]}',
        "--occurred-at",
        "2026-01-05T15:00:00.000Z",
      ],
      ctx
    );

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      kind: "mood",
      payload: { rating: 2, labels: ["anxious", "irritated"] },
      status: null,
      occurred_at: "2026-01-05T15:00:00.000Z",
    });

    const kind = JSON.parse((await runCommand(["kinds", "mood"], ctx)).stdout);
    expect(kind.statuses).toBeNull();
    expect(kind.default_status).toBeNull();
    expect(kind.payload_schema.required).toEqual(["rating"]);
  });

  it("T18.2 mood rejects out-of-scale rating and --status", async () => {
    const badRating = await runCommand(
      ["add", "mood", "--title", "x", "--payload", '{"rating":6}'],
      makeTestContext()
    );
    expect(badRating.exitCode).toBe(1);
    expect(badRating.stdout).toBe("");
    expect(JSON.parse(badRating.stderr).error.code).toBe("VALIDATION_FAILED");

    const withStatus = await runCommand(
      [
        "add",
        "mood",
        "--title",
        "x",
        "--payload",
        '{"rating":3}',
        "--status",
        "active",
      ],
      makeTestContext()
    );
    expect(withStatus.exitCode).toBe(1);
    expect(JSON.parse(withStatus.stderr).error.code).toBe("INVALID_STATUS");
  });

  it("T18.3 sleep: duration is the identity, quality/bed/wake optional", async () => {
    const ctx = makeTestContext();
    const full = await runCommand(
      [
        "add",
        "sleep",
        "--title",
        "Rough night",
        "--payload",
        '{"duration_min":390,"quality":2,"bed_at":"2026-01-04T23:30:00.000Z","woke_at":"2026-01-05T06:00:00.000Z"}',
        "--occurred-at",
        "2026-01-05T06:00:00.000Z",
      ],
      ctx
    );
    expect(full.exitCode).toBe(0);
    expect(JSON.parse(full.stdout)).toMatchObject({
      kind: "sleep",
      payload: { duration_min: 390, quality: 2 },
      status: null,
    });

    const noDuration = await runCommand(
      ["add", "sleep", "--title", "x", "--payload", '{"quality":3}'],
      ctx
    );
    expect(noDuration.exitCode).toBe(1);
    const err = JSON.parse(noDuration.stderr).error;
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toContain("duration_min");
  });

  it("T18.4 activity: canonical name required; effort and enjoyment are independent axes", async () => {
    const ctx = makeTestContext();
    const full = await runCommand(
      [
        "add",
        "activity",
        "--title",
        "Grouse Grind",
        "--payload",
        '{"name":"hike","duration_min":95,"distance_km":2.9,"effort":5,"enjoyment":5,"weather":"cold drizzle","location":"Grouse Mountain"}',
        "--occurred-at",
        "2026-01-05T09:00:00.000Z",
      ],
      ctx
    );
    expect(full.exitCode).toBe(0);
    expect(JSON.parse(full.stdout)).toMatchObject({
      kind: "activity",
      payload: { name: "hike", effort: 5, enjoyment: 5 },
      status: null,
    });

    const noName = await runCommand(
      ["add", "activity", "--title", "x", "--payload", '{"effort":3}'],
      ctx
    );
    expect(noName.exitCode).toBe(1);
    const err = JSON.parse(noName.stderr).error;
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toContain("name");
  });

  it("T18.5 mood/sleep/activity join the health set: cross-kind temporal pairs proposed", async () => {
    const ctx = makeTestContext();
    const add = async (args: string[]) =>
      JSON.parse((await runCommand(["add", ...args], ctx)).stdout);
    const meal = await add([
      "meal",
      "--title",
      "Lunch",
      "--payload",
      '{"items":["sourdough","bread"]}',
      "--occurred-at",
      "2026-01-05T12:00:00.000Z",
    ]);
    const mood = await add([
      "mood",
      "--title",
      "Foggy afternoon",
      "--payload",
      '{"rating":2,"labels":["foggy"]}',
      "--occurred-at",
      "2026-01-05T15:00:00.000Z",
    ]);
    const sleep = await add([
      "sleep",
      "--title",
      "Short night",
      "--payload",
      '{"duration_min":300}',
      "--occurred-at",
      "2026-01-05T06:00:00.000Z",
    ]);
    const activity = await add([
      "activity",
      "--title",
      "Morning run",
      "--payload",
      '{"name":"run"}',
      "--occurred-at",
      "2026-01-05T09:00:00.000Z",
    ]);

    await runCommand(["suggest"], ctx);
    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string; reason: string }>;
    const pairs = pending.map((s) => `${s.src}|${s.dst}`);

    // canonical src < dst; ids are sequential, meal created first
    expect(pairs).toContain(`${meal.id}|${mood.id}`);
    expect(pairs).toContain(`${meal.id}|${sleep.id}`);
    expect(pairs).toContain(`${meal.id}|${activity.id}`);
  });

  it("T18.6 med-adjacency reaches the new health kinds", async () => {
    const ctx = makeTestContext();
    const mood = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "mood",
            "--title",
            "Brain fog",
            "--payload",
            '{"rating":2,"labels":["foggy"]}',
            "--occurred-at",
            "2026-02-01T15:00:00.000Z",
          ],
          ctx
        )
      ).stdout
    );
    const note = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "note",
            "--title",
            "Fog started after switching to rye",
            "--link",
            `${mood.id}:about`,
            "--occurred-at",
            "2026-02-01T16:00:00.000Z",
          ],
          ctx
        )
      ).stdout
    );

    const out = JSON.parse(
      (await runCommand(["report", "medical-history"], ctx)).stdout
    );
    const notes = out.notes as Array<{ id: string }>;
    expect(notes.map((n) => n.id)).toContain(note.id);
  });
});
