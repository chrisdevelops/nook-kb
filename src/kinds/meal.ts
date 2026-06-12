import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const meal: KindDef = {
  statuses: null,
  defaultStatus: null,
  health: true,
  description: "A meal eaten; occurred_at is when it was eaten",
  payload: Type.Object(
    {
      items: Type.Array(Type.String()),
      meal_type: Type.Optional(
        Type.Union([
          Type.Literal("breakfast"),
          Type.Literal("lunch"),
          Type.Literal("dinner"),
          Type.Literal("snack"),
        ])
      ),
    },
    { additionalProperties: false }
  ),
};
