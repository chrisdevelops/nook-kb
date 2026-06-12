import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { makeTestContext } from "./testing";

describe("Item 20 — medication kind (statusful regimen, occurred_at mirror)", () => {
  it("T20.1 regimen round-trips: default active, occurred_at mirrors started_at", async () => {
    const ctx = makeTestContext();
    const res = await runCommand(
      [
        "add",
        "medication",
        "--title",
        "Lisinopril",
        "--payload",
        '{"name":"lisinopril","dose":"10mg daily","prescriber":"Dr. Okafor","started_at":"2026-03-01T00:00:00.000Z"}',
      ],
      ctx
    );

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      kind: "medication",
      payload: { name: "lisinopril", dose: "10mg daily" },
      status: "active",
      occurred_at: "2026-03-01T00:00:00.000Z",
    });

    const kind = JSON.parse(
      (await runCommand(["kinds", "medication"], ctx)).stdout
    );
    expect(kind.statuses).toEqual(["active", "stopped"]);
    expect(kind.default_status).toBe("active");
    expect(kind.payload_schema.required).toEqual(["name"]);
  });

  it("T20.2 --occurred-at is INVALID_ARGS on medication add and update", async () => {
    const ctx = makeTestContext();
    const onAdd = await runCommand(
      [
        "add",
        "medication",
        "--title",
        "x",
        "--payload",
        '{"name":"lisinopril"}',
        "--occurred-at",
        "2026-03-01T00:00:00.000Z",
      ],
      ctx
    );
    expect(onAdd.exitCode).toBe(1);
    expect(JSON.parse(onAdd.stderr).error.code).toBe("INVALID_ARGS");

    const med = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "medication",
            "--title",
            "x",
            "--payload",
            '{"name":"lisinopril"}',
          ],
          ctx
        )
      ).stdout
    );
    const onUpdate = await runCommand(
      ["update", med.id, "--occurred-at", "2026-03-01T00:00:00.000Z"],
      ctx
    );
    expect(onUpdate.exitCode).toBe(1);
    expect(JSON.parse(onUpdate.stderr).error.code).toBe("INVALID_ARGS");
  });

  it("T20.3 mirror takeover: null until started_at is set, then re-fires on change", async () => {
    const ctx = makeTestContext();
    const med = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "medication",
            "--title",
            "Vit D",
            "--payload",
            '{"name":"vitamin d"}',
          ],
          ctx
        )
      ).stdout
    );
    // no started_at yet: occurred_at stays null — created_at fallback = add-time
    expect(med.occurred_at).toBeNull();

    const firstSet = JSON.parse(
      (
        await runCommand(
          [
            "update",
            med.id,
            "--payload-merge",
            '{"started_at":"2026-02-01T00:00:00.000Z"}',
          ],
          ctx
        )
      ).stdout
    );
    expect(firstSet.occurred_at).toBe("2026-02-01T00:00:00.000Z");

    const corrected = JSON.parse(
      (
        await runCommand(
          [
            "update",
            med.id,
            "--payload-merge",
            '{"started_at":"2026-01-15T00:00:00.000Z"}',
          ],
          ctx
        )
      ).stdout
    );
    expect(corrected.occurred_at).toBe("2026-01-15T00:00:00.000Z");
  });

  it("T20.4 medication joins the health set: temporal pairs and med-adjacency", async () => {
    const ctx = makeTestContext();
    const med = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "medication",
            "--title",
            "Lisinopril",
            "--payload",
            '{"name":"lisinopril","started_at":"2026-01-05T00:00:00.000Z"}',
          ],
          ctx
        )
      ).stdout
    );
    const symptom = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "symptom",
            "--title",
            "Dry cough",
            "--payload",
            '{"name":"dry cough"}',
            "--occurred-at",
            "2026-01-05T18:00:00.000Z",
          ],
          ctx
        )
      ).stdout
    );

    // a symptom near a regimen start is the side-effect signal
    await runCommand(["suggest"], ctx);
    const pending = JSON.parse(
      (await runCommand(["suggest", "review"], ctx)).stdout
    ) as Array<{ src: string; dst: string }>;
    expect(pending.map((s) => `${s.src}|${s.dst}`)).toContain(
      `${med.id}|${symptom.id}`
    );

    // a note linked to a medication is med-adjacent
    const note = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "note",
            "--title",
            "Cough started a few days in",
            "--link",
            `${med.id}:about`,
          ],
          ctx
        )
      ).stdout
    );
    const out = JSON.parse(
      (await runCommand(["report", "medical-history"], ctx)).stdout
    );
    expect((out.notes as Array<{ id: string }>).map((n) => n.id)).toContain(
      note.id
    );
  });

  it("T20.5 stopped is a lifecycle state, not a terminal one: stays retrieval-visible", async () => {
    const ctx = makeTestContext();
    const med = JSON.parse(
      (
        await runCommand(
          [
            "add",
            "medication",
            "--title",
            "Lisinopril",
            "--payload",
            '{"name":"lisinopril"}',
          ],
          ctx
        )
      ).stdout
    );
    await runCommand(["update", med.id, "--status", "stopped"], ctx);

    const listed = JSON.parse(
      (await runCommand(["query", "--kind", "medication"], ctx)).stdout
    ) as Array<{ id: string }>;
    expect(listed.map((r) => r.id)).toContain(med.id);

    const got = JSON.parse((await runCommand(["get", med.id], ctx)).stdout) as {
      status: string;
    };
    expect(got.status).toBe("stopped");

    const bad = await runCommand(["update", med.id, "--status", "paused"], ctx);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stderr).error.code).toBe("INVALID_STATUS");
  });
});
