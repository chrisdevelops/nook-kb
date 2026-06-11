import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCommand } from "./run-command";
import { makeTestContext } from "./testing";

function withConfig(content: string) {
  const ctx = makeTestContext();
  const configPath = join(dirname(ctx.dbPath), "memory.jsonc");
  writeFileSync(configPath, content);
  return { ...ctx, configPath };
}

describe("Item 1 — config", () => {
  it("T1.3 unknown key is a warning, not an error", async () => {
    const ctx = withConfig(`{
      // forward-compat: future versions may know this key
      "futureKnob": true,
    }`);
    const res = await runCommand(["stats"], ctx);

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toBeTruthy();
    expect(res.stderr).toContain("futureKnob");
  });

  it("T1.4 malformed config is a system error", async () => {
    const ctx = withConfig("{ this is not jsonc");
    const res = await runCommand(["stats"], ctx);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr).error.code).toBe("SYSTEM");
  });

  it("absent config file means defaults, no warnings", async () => {
    const ctx = makeTestContext();
    const res = await runCommand(["stats"], ctx);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
  });

  it("T1.1 config respected: purge.default_days 0 purges immediately", async () => {
    const ctx = withConfig('{ "purge": { "default_days": 0 } }');
    const { id } = JSON.parse(
      (await runCommand(["add", "note", "--title", "doomed"], ctx)).stdout
    );
    await runCommand(["delete", id], ctx);

    const res = await runCommand(["purge"], ctx);
    expect(JSON.parse(res.stdout)).toEqual({ purged: 1 });
  });

  it("T1.2 flag beats config", async () => {
    const ctx = withConfig('{ "purge": { "default_days": 0 } }');
    const { id } = JSON.parse(
      (await runCommand(["add", "note", "--title", "survivor"], ctx)).stdout
    );
    await runCommand(["delete", id], ctx);

    const res = await runCommand(["purge", "--older-than", "365"], ctx);
    expect(JSON.parse(res.stdout)).toEqual({ purged: 0 });
  });
});
