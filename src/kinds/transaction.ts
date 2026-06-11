import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const transaction: KindDef = {
  statuses: null,
  defaultStatus: null,
  description: "Money in or out; memory of it, not the system of record",
  payload: Type.Object(
    {
      amount: Type.Number(),
      currency: Type.Literal("CAD"),
      direction: Type.Union([Type.Literal("income"), Type.Literal("expense")]),
      category: Type.Optional(Type.String()),
      vendor: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  ),
};
