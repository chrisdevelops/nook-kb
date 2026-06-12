import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command";
import { addNode as add, makeTestContext, reportJson } from "./testing";
import type { Context } from "./context";

const report = (ctx: Context, args: string[] = []) =>
  reportJson(ctx, "finance", args);

function addTx(
  ctx: Context,
  title: string,
  payload: Record<string, unknown>,
  at?: string
) {
  const args = ["transaction", "--title", title, "--payload"];
  args.push(JSON.stringify({ currency: "CAD", ...payload }));
  if (at) args.push("--occurred-at", at);
  return add(ctx, args);
}

describe("Item 15 — report finance (Phase 3)", () => {
  it("T15.1 income vs expenses by category, totals descending, uncategorized bucket, net", async () => {
    const ctx = makeTestContext();
    await addTx(ctx, "Safekeep milestone", {
      amount: 2500,
      direction: "income",
      category: "client-work",
    });
    await addTx(ctx, "App Store payout", {
      amount: 300,
      direction: "income",
      category: "products",
    });
    await addTx(ctx, "Groceries", {
      amount: 120.5,
      direction: "expense",
      category: "food",
    });
    await addTx(ctx, "Restaurant", {
      amount: 80,
      direction: "expense",
      category: "food",
    });
    await addTx(ctx, "Server bill", {
      amount: 40,
      direction: "expense",
      category: "infra",
    });
    await addTx(ctx, "Cash withdrawal", {
      amount: 200,
      direction: "expense",
    }); // no category

    const out = await report(ctx);
    expect(out.report).toBe("finance");
    expect(out.month).toBeNull();

    const income = out.income as {
      total: number;
      by_category: Array<Record<string, unknown>>;
    };
    expect(income.total).toBe(2800);
    expect(income.by_category).toEqual([
      { category: "client-work", total: 2500, count: 1 },
      { category: "products", total: 300, count: 1 },
    ]);

    const expenses = out.expenses as {
      total: number;
      by_category: Array<Record<string, unknown>>;
    };
    expect(expenses.total).toBe(440.5);
    expect(expenses.by_category).toEqual([
      { category: "food", total: 200.5, count: 2 },
      { category: "uncategorized", total: 200, count: 1 },
      { category: "infra", total: 40, count: 1 },
    ]);

    expect(out.net).toBe(2359.5);
  });

  it("T15.2 --month scopes to the calendar month on occurred_at falling back to created_at", async () => {
    const ctx = makeTestContext();
    await addTx(
      ctx,
      "Feb invoice",
      { amount: 1000, direction: "income", category: "client-work" },
      "2026-02-10T12:00:00.000Z"
    );
    await addTx(
      ctx,
      "Mar invoice",
      { amount: 700, direction: "income", category: "client-work" },
      "2026-03-05T12:00:00.000Z"
    );
    // no --occurred-at: created_at is 2026-01-01 (test clock)
    await addTx(ctx, "January cash", { amount: 50, direction: "expense" });

    const feb = await report(ctx, ["--month", "2026-02"]);
    expect(feb.month).toBe("2026-02");
    expect((feb.income as { total: number }).total).toBe(1000);
    expect((feb.expenses as { total: number }).total).toBe(0);
    expect((feb.expenses as { by_category: unknown[] }).by_category).toEqual(
      []
    );

    const jan = await report(ctx, ["--month", "2026-01"]);
    expect((jan.expenses as { total: number }).total).toBe(50); // created_at fallback
    expect((jan.income as { total: number }).total).toBe(0);

    for (const bad of ["2026-13", "march", "2026-3", "2026-02-01"]) {
      const res = await runCommand(["report", "finance", "--month", bad], ctx);
      expect(res.exitCode).toBe(1);
      expect(JSON.parse(res.stderr).error.code).toBe("INVALID_ARGS");
    }
  });

  it("T15.3 subscription burn: yearly normalized, cancelled excluded from burn but listed", async () => {
    const ctx = makeTestContext();
    const addSub = (
      title: string,
      payload: Record<string, unknown>,
      status?: string
    ) => {
      const args = [
        "subscription",
        "--title",
        title,
        "--payload",
        JSON.stringify({ currency: "CAD", ...payload }),
      ];
      if (status) args.push("--status", status);
      return add(ctx, args);
    };
    const streaming = await addSub("Streaming", {
      amount: 15,
      cadence: "monthly",
      vendor: "Streamflix",
    });
    const domains = await addSub("Domain renewal", {
      amount: 130,
      cadence: "yearly",
      vendor: "Hover",
    });
    const gym = await addSub(
      "Gym",
      { amount: 9, cadence: "monthly", vendor: "GoodLife" },
      "cancelled"
    );

    const out = await report(ctx);
    const subs = out.subscriptions as {
      monthly_burn: number;
      items: Array<Record<string, unknown>>;
    };
    expect(subs.monthly_burn).toBe(25.83); // 15 + 130/12, cancelled excluded
    expect(subs.items.map((i) => i.id)).toEqual([
      streaming.id, // active first, monthly_equivalent descending
      domains.id,
      gym.id,
    ]);
    expect(subs.items[0]).toMatchObject({
      vendor: "Streamflix",
      amount: 15,
      cadence: "monthly",
      status: "active",
      monthly_equivalent: 15,
    });
    expect(subs.items[1]).toMatchObject({
      cadence: "yearly",
      monthly_equivalent: 10.83,
    });
    expect(subs.items[2]).toMatchObject({ status: "cancelled" });
  });

  it("T15.4 soft-deleted transactions and subscriptions excluded everywhere", async () => {
    const ctx = makeTestContext();
    const tx = await addTx(ctx, "Refunded purchase", {
      amount: 99,
      direction: "expense",
      category: "gear",
    });
    const sub = await add(ctx, [
      "subscription",
      "--title",
      "Trial",
      "--payload",
      '{"amount":20,"currency":"CAD","cadence":"monthly","vendor":"TrialCo"}',
    ]);
    await runCommand(["delete", tx.id], ctx);
    await runCommand(["delete", sub.id], ctx);

    const out = await report(ctx);
    expect((out.expenses as { total: number }).total).toBe(0);
    expect((out.subscriptions as { monthly_burn: number }).monthly_burn).toBe(
      0
    );
    expect((out.subscriptions as { items: unknown[] }).items).toEqual([]);
  });

  it("T15.5 --human renders markdown sections", async () => {
    const ctx = makeTestContext();
    await addTx(
      ctx,
      "Feb invoice",
      { amount: 1000, direction: "income", category: "client-work" },
      "2026-02-10T12:00:00.000Z"
    );
    await addTx(
      ctx,
      "Groceries",
      { amount: 120.5, direction: "expense", category: "food" },
      "2026-02-12T12:00:00.000Z"
    );
    await add(ctx, [
      "subscription",
      "--title",
      "Streaming",
      "--payload",
      '{"amount":15,"currency":"CAD","cadence":"monthly","vendor":"Streamflix"}',
    ]);

    const res = await runCommand(
      ["report", "finance", "--month", "2026-02", "--human"],
      ctx
    );
    expect(res.exitCode).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow(); // markdown, not JSON
    expect(res.stdout).toContain("# Finance");
    expect(res.stdout).toContain("2026-02");
    expect(res.stdout).toContain("## Income");
    expect(res.stdout).toContain("client-work");
    expect(res.stdout).toContain("## Expenses");
    expect(res.stdout).toContain("food");
    expect(res.stdout).toContain("## Subscriptions");
    expect(res.stdout).toContain("Streamflix");
  });

  it("T15.6 category ordering uses the displayed cent totals, not raw float sums", async () => {
    const ctx = makeTestContext();
    // 0.1 + 0.2 accumulates to 0.30000000000000004 as a REAL sum; the
    // category-ascending tiebreak must apply to the displayed 0.30s
    await addTx(ctx, "Tea", {
      amount: 0.1,
      direction: "expense",
      category: "zfood",
    });
    await addTx(ctx, "Gum", {
      amount: 0.2,
      direction: "expense",
      category: "zfood",
    });
    await addTx(ctx, "Mint", {
      amount: 0.3,
      direction: "expense",
      category: "afood",
    });

    const out = await report(ctx);
    const expenses = out.expenses as {
      by_category: Array<{ category: string; total: number }>;
    };
    expect(expenses.by_category.map((c) => c.category)).toEqual([
      "afood",
      "zfood",
    ]);
    expect(expenses.by_category.map((c) => c.total)).toEqual([0.3, 0.3]);
  });
});
