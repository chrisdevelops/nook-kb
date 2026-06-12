import { UserError } from "../errors";
import type { Db } from "../sqlite";

type CategoryRow = { category: string; total: number; count: number };

type SubscriptionItem = {
  id: string;
  title: string;
  vendor: string;
  amount: number;
  cadence: "monthly" | "yearly";
  status: "active" | "cancelled";
  monthly_equivalent: number;
};

export type FinanceReport = {
  report: "finance";
  month: string | null;
  income: { total: number; by_category: CategoryRow[] };
  expenses: { total: number; by_category: CategoryRow[] };
  net: number;
  subscriptions: { monthly_burn: number; items: SubscriptionItem[] };
};

const cents = (n: number) => Math.round(n * 100) / 100;

export function finance(db: Db, flags: { month?: string } = {}): FinanceReport {
  const month = flags.month ?? null;
  if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new UserError("INVALID_ARGS", "--month must be YYYY-MM");
  }
  // calendar-month scope on occurred_at falling back to created_at (§5.2 convention)
  const monthSql =
    month === null
      ? ""
      : " AND substr(COALESCE(occurred_at, created_at), 1, 7) = ?";
  const monthParams = month === null ? [] : [month];

  const byDirection = (direction: "income" | "expense") => {
    const by_category = db
      .all(
        `SELECT COALESCE(json_extract(payload, '$.category'), 'uncategorized') AS category,
                SUM(amount) AS total, COUNT(*) AS count
         FROM nodes
         WHERE kind = 'transaction' AND deleted_at IS NULL
           AND json_extract(payload, '$.direction') = ?${monthSql}
         GROUP BY category
         ORDER BY total DESC, category ASC`,
        direction,
        ...monthParams
      )
      .map((r) => ({
        category: r.category as string,
        total: cents(r.total as number),
        count: r.count as number,
      }));
    const total = cents(by_category.reduce((sum, c) => sum + c.total, 0));
    return { total, by_category };
  };

  const income = byDirection("income");
  const expenses = byDirection("expense");

  // current state, not month-scoped: burn projects forward from active subs
  const items: SubscriptionItem[] = db
    .all(
      `SELECT id, title, status, payload FROM nodes
       WHERE kind = 'subscription' AND deleted_at IS NULL`
    )
    .map((r) => {
      const p = JSON.parse(r.payload as string) as {
        amount: number;
        cadence: "monthly" | "yearly";
        vendor: string;
      };
      return {
        id: r.id as string,
        title: r.title as string,
        vendor: p.vendor,
        amount: p.amount,
        cadence: p.cadence,
        status: r.status as "active" | "cancelled",
        monthly_equivalent: cents(
          p.cadence === "yearly" ? p.amount / 12 : p.amount
        ),
      };
    })
    .sort(
      (a, b) =>
        (a.status === "cancelled" ? 1 : 0) -
          (b.status === "cancelled" ? 1 : 0) ||
        b.monthly_equivalent - a.monthly_equivalent ||
        a.vendor.localeCompare(b.vendor)
    );
  const monthly_burn = cents(
    items
      .filter((i) => i.status === "active")
      .reduce((sum, i) => sum + i.monthly_equivalent, 0)
  );

  return {
    report: "finance",
    month,
    income,
    expenses,
    net: cents(income.total - expenses.total),
    subscriptions: { monthly_burn, items },
  };
}

/** `--human`: markdown summary (SPEC §5.3). */
export function renderFinanceHuman(r: FinanceReport): string {
  const out: string[] = ["# Finance"];
  if (r.month !== null) out.push(`_month ${r.month}_`);

  const section = (
    title: string,
    side: { total: number; by_category: CategoryRow[] }
  ) => {
    out.push("", `## ${title} — ${side.total.toFixed(2)} CAD`);
    if (side.by_category.length === 0) out.push("_none_");
    for (const c of side.by_category) {
      out.push(`- ${c.category}: ${c.total.toFixed(2)} (×${c.count})`);
    }
  };
  section("Income", r.income);
  section("Expenses", r.expenses);
  out.push("", `**Net: ${r.net.toFixed(2)} CAD**`);

  out.push(
    "",
    `## Subscriptions — ${r.subscriptions.monthly_burn.toFixed(2)} CAD/month projected`
  );
  if (r.subscriptions.items.length === 0) out.push("_none_");
  for (const s of r.subscriptions.items) {
    const cancelled = s.status === "cancelled" ? " — cancelled" : "";
    out.push(
      `- ${s.vendor}: ${s.amount.toFixed(2)} ${s.cadence} (${s.monthly_equivalent.toFixed(2)}/month)${cancelled}`
    );
  }

  return out.join("\n");
}
