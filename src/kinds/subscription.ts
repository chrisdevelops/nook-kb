import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const subscription: KindDef = {
  statuses: ["active", "cancelled"],
  defaultStatus: "active",
  description: "Recurring charge; cadence-normalized in the finance report",
  payload: Type.Object(
    {
      amount: Type.Number(),
      currency: Type.Literal("CAD"),
      cadence: Type.Union([Type.Literal("monthly"), Type.Literal("yearly")]),
      vendor: Type.String(),
      renews_at: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  ),
};
