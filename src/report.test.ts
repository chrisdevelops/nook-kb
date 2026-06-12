import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { addNode as add, makeTestContext, reportJson } from "./testing";
import type { Context } from "./context";

const report = (ctx: Context, args: string[] = []) =>
  reportJson(ctx, "medical-history", args);

describe("Item 14 — report medical-history (Phase 3)", () => {
  it("T14.1 visits in chronological order with payload fields", async () => {
    const ctx = makeTestContext();
    const later = await add(ctx, [
      "visit",
      "--title",
      "Dermatology follow-up",
      "--payload",
      '{"provider":"Dr. Reyes","specialty":"dermatology","summary_outcome":"biopsy clear"}',
      "--occurred-at",
      "2026-03-10T15:00:00.000Z",
    ]);
    const earlier = await add(ctx, [
      "visit",
      "--title",
      "GP checkup",
      "--payload",
      '{"provider":"Dr. Okafor"}',
      "--occurred-at",
      "2026-02-01T09:00:00.000Z",
    ]);

    const out = await report(ctx);
    expect(out.report).toBe("medical-history");
    const visits = out.visits as Array<Record<string, unknown>>;
    expect(visits.map((v) => v.id)).toEqual([earlier.id, later.id]);
    expect(visits[1]).toMatchObject({
      title: "Dermatology follow-up",
      provider: "Dr. Reyes",
      specialty: "dermatology",
      summary_outcome: "biopsy clear",
      occurred_at: "2026-03-10T15:00:00.000Z",
    });
  });

  it("T14.2 symptoms grouped by payload name: frequency, chronological occurrences, severity trend", async () => {
    const ctx = makeTestContext();
    const addSymptom = (
      title: string,
      payload: Record<string, unknown>,
      at: string
    ) =>
      add(ctx, [
        "symptom",
        "--title",
        title,
        "--payload",
        JSON.stringify(payload),
        "--occurred-at",
        at,
      ]);
    // grouping key is payload.name, not title
    const h1 = await addSymptom(
      "Morning headache",
      { name: "headache", severity: 2 },
      "2026-01-05T08:00:00.000Z"
    );
    const h3 = await addSymptom(
      "Headache after lunch",
      { name: "headache", severity: 4 },
      "2026-01-20T13:00:00.000Z"
    );
    const h2 = await addSymptom(
      "Headache again",
      { name: "headache", severity: 3 },
      "2026-01-12T09:00:00.000Z"
    );
    const n1 = await addSymptom(
      "Queasy",
      { name: "nausea" },
      "2026-01-10T10:00:00.000Z"
    );

    const out = await report(ctx);
    const symptoms = out.symptoms as Array<{
      name: string;
      count: number;
      severity_trend: string | null;
      occurrences: Array<Record<string, unknown>>;
    }>;
    // most frequent first
    expect(symptoms.map((s) => s.name)).toEqual(["headache", "nausea"]);

    const headache = symptoms[0]!;
    expect(headache.count).toBe(3);
    expect(headache.occurrences.map((o) => o.id)).toEqual([
      h1.id,
      h2.id,
      h3.id,
    ]);
    expect(headache.occurrences[0]).toMatchObject({
      occurred_at: "2026-01-05T08:00:00.000Z",
      severity: 2,
    });
    expect(headache.severity_trend).toBe("rising");

    const nausea = symptoms[1]!;
    expect(nausea.count).toBe(1);
    expect(nausea.occurrences[0]).toMatchObject({ id: n1.id, severity: null });
    expect(nausea.severity_trend).toBeNull();
  });

  it("T14.3 lab results as chronological panels with marker rows intact", async () => {
    const ctx = makeTestContext();
    const later = await add(ctx, [
      "lab_result",
      "--title",
      "Spring bloodwork",
      "--payload",
      '{"panel":"lipids","results":[{"marker":"LDL","value":3.1,"unit":"mmol/L","ref_high":3.4}]}',
      "--occurred-at",
      "2026-04-01T09:00:00.000Z",
    ]);
    const earlier = await add(ctx, [
      "lab_result",
      "--title",
      "Winter bloodwork",
      "--payload",
      '{"panel":"cbc","results":[{"marker":"hemoglobin","value":141,"unit":"g/L","ref_low":130,"ref_high":170},{"marker":"WBC","value":6.2,"unit":"10^9/L"}]}',
      "--occurred-at",
      "2026-01-15T09:00:00.000Z",
    ]);

    const out = await report(ctx);
    const labs = out.labs as Array<Record<string, unknown>>;
    expect(labs.map((l) => l.id)).toEqual([earlier.id, later.id]);
    expect(labs[0]).toMatchObject({
      panel: "cbc",
      occurred_at: "2026-01-15T09:00:00.000Z",
      results: [
        {
          marker: "hemoglobin",
          value: 141,
          unit: "g/L",
          ref_low: 130,
          ref_high: 170,
        },
        { marker: "WBC", value: 6.2, unit: "10^9/L" },
      ],
    });
  });

  it("T14.4 med-adjacent notes: edge to a health node or a health tag; others excluded", async () => {
    const ctx = makeTestContext();
    const visit = await add(ctx, [
      "visit",
      "--title",
      "GP checkup",
      "--payload",
      '{"provider":"Dr. Okafor"}',
      "--occurred-at",
      "2026-02-01T09:00:00.000Z",
    ]);
    const linked = await add(ctx, [
      "note",
      "--title",
      "Started lisinopril",
      "--body",
      "10mg daily as discussed",
      "--link",
      `${visit.id}:about`,
      "--occurred-at",
      "2026-02-01T10:00:00.000Z",
    ]);
    const tagged = await add(ctx, [
      "note",
      "--title",
      "Pharmacy switched generics",
      "--tag",
      "health/meds",
      "--occurred-at",
      "2026-03-01T10:00:00.000Z",
    ]);
    await add(ctx, [
      "note",
      "--title",
      "Square delayed capture gotchas",
      "--body",
      "client work, nothing medical",
    ]);
    // tag matching is case-sensitive, like every other tag comparison
    await add(ctx, [
      "note",
      "--title",
      "Wrong-case tag",
      "--tag",
      "Health/meds",
    ]);

    const out = await report(ctx);
    const notes = out.notes as Array<Record<string, unknown>>;
    expect(notes.map((n) => n.id)).toEqual([linked.id, tagged.id]);
    expect(notes[0]).toMatchObject({
      title: "Started lisinopril",
      body: "10mg daily as discussed",
      occurred_at: "2026-02-01T10:00:00.000Z",
    });
  });

  it("T14.5 --since filters occurred_at falling back to created_at, across sections", async () => {
    const ctx = makeTestContext();
    await add(ctx, [
      "visit",
      "--title",
      "Old visit",
      "--payload",
      '{"provider":"Dr. Okafor"}',
      "--occurred-at",
      "2025-11-01T09:00:00.000Z",
    ]);
    const recentVisit = await add(ctx, [
      "visit",
      "--title",
      "Recent visit",
      "--payload",
      '{"provider":"Dr. Okafor"}',
      "--occurred-at",
      "2026-03-01T09:00:00.000Z",
    ]);
    await add(ctx, [
      "symptom",
      "--title",
      "Old headache",
      "--payload",
      '{"name":"headache","severity":2}',
      "--occurred-at",
      "2025-12-01T09:00:00.000Z",
    ]);
    const recentSymptom = await add(ctx, [
      "symptom",
      "--title",
      "Recent headache",
      "--payload",
      '{"name":"headache","severity":3}',
      "--occurred-at",
      "2026-03-02T09:00:00.000Z",
    ]);
    // no --occurred-at: falls back to created_at (test clock starts 2026-01-01)
    await add(ctx, [
      "note",
      "--title",
      "Med note from January",
      "--tag",
      "health/meds",
    ]);

    const out = await report(ctx, ["--since", "2026-02-01T00:00:00.000Z"]);
    expect(out.since).toBe("2026-02-01T00:00:00.000Z");
    expect((out.visits as Array<{ id: string }>).map((v) => v.id)).toEqual([
      recentVisit.id,
    ]);
    const symptoms = out.symptoms as Array<{
      count: number;
      severity_trend: string | null;
      occurrences: Array<{ id: string }>;
    }>;
    expect(symptoms[0]!.count).toBe(1);
    expect(symptoms[0]!.occurrences.map((o) => o.id)).toEqual([
      recentSymptom.id,
    ]);
    expect(symptoms[0]!.severity_trend).toBeNull(); // trend over filtered window only
    expect(out.notes).toEqual([]); // created_at fallback puts the note before the cutoff
  });

  it("T14.6 soft-deleted nodes excluded, including adjacency through a deleted health node", async () => {
    const ctx = makeTestContext();
    const visit = await add(ctx, [
      "visit",
      "--title",
      "Deleted visit",
      "--payload",
      '{"provider":"Dr. Reyes"}',
      "--occurred-at",
      "2026-02-01T09:00:00.000Z",
    ]);
    await add(ctx, [
      "note",
      "--title",
      "Note about the deleted visit",
      "--link",
      `${visit.id}:about`,
    ]);
    const taggedNote = await add(ctx, [
      "note",
      "--title",
      "Deleted med note",
      "--tag",
      "health/meds",
    ]);
    await runCommand(["delete", visit.id], ctx);
    await runCommand(["delete", taggedNote.id], ctx);

    const out = await report(ctx);
    expect(out.visits).toEqual([]);
    expect(out.notes).toEqual([]); // its only health link points at a deleted node
  });

  it("T14.7 --human renders markdown sections", async () => {
    const ctx = makeTestContext();
    await add(ctx, [
      "visit",
      "--title",
      "GP checkup",
      "--payload",
      '{"provider":"Dr. Okafor","specialty":"family medicine"}',
      "--occurred-at",
      "2026-02-01T09:00:00.000Z",
    ]);
    await add(ctx, [
      "symptom",
      "--title",
      "Headache",
      "--payload",
      '{"name":"headache","severity":3}',
      "--occurred-at",
      "2026-01-05T08:00:00.000Z",
    ]);
    await add(ctx, [
      "lab_result",
      "--title",
      "Winter bloodwork",
      "--payload",
      '{"panel":"cbc","results":[{"marker":"hemoglobin","value":141,"unit":"g/L","ref_low":130,"ref_high":170}]}',
      "--occurred-at",
      "2026-01-15T09:00:00.000Z",
    ]);
    await add(ctx, [
      "note",
      "--title",
      "Started lisinopril",
      "--tag",
      "health/meds",
    ]);

    const res = await runCommand(["report", "medical-history", "--human"], ctx);
    expect(res.exitCode).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow(); // markdown, not JSON
    expect(res.stdout).toContain("# Medical history");
    expect(res.stdout).toContain("## Visits");
    expect(res.stdout).toContain("Dr. Okafor");
    expect(res.stdout).toContain("## Symptoms");
    expect(res.stdout).toContain("headache");
    expect(res.stdout).toContain("## Lab results");
    expect(res.stdout).toContain("hemoglobin");
    expect(res.stdout).toContain("## Notes");
    expect(res.stdout).toContain("Started lisinopril");
  });

  it("T14.8 unknown report name → INVALID_ARGS", async () => {
    const ctx = makeTestContext();
    const res = await runCommand(["report", "no-such-report"], ctx);
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stderr).error.code).toBe("INVALID_ARGS");
  });

  it("T14.9 a flag belonging to a different report → INVALID_ARGS, never silently ignored", async () => {
    const ctx = makeTestContext();
    const wrong: Array<[string, string, string]> = [
      ["medical-history", "--month", "2026-02"],
      ["medical-history", "--project", "Safekeep"],
      ["finance", "--since", "2026-01-01"],
      ["finance", "--project", "Safekeep"],
      ["tasks", "--since", "2026-01-01"],
      ["tasks", "--month", "2026-02"],
    ];
    for (const [name, flag, value] of wrong) {
      const res = await runCommand(["report", name, flag, value], ctx);
      expect(res.exitCode, `${name} ${flag}`).toBe(1);
      expect(JSON.parse(res.stderr).error.code).toBe("INVALID_ARGS");
    }
  });

  it("T14.10 malformed --since → INVALID_ARGS; date-only and full ISO accepted", async () => {
    const ctx = makeTestContext();
    for (const bad of ["march", "05/01/2026", "2026-13-01", "2026-02-30"]) {
      const res = await runCommand(
        ["report", "medical-history", "--since", bad],
        ctx
      );
      expect(res.exitCode, bad).toBe(1);
      expect(JSON.parse(res.stderr).error.code).toBe("INVALID_ARGS");
    }
    for (const good of ["2026-02-01", "2026-02-01T09:00:00.000Z"]) {
      const out = await report(ctx, ["--since", good]);
      expect(out.since).toBe(good);
    }
  });
});
