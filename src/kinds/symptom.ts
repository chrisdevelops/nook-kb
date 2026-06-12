import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const symptom: KindDef = {
  statuses: null,
  defaultStatus: null,
  health: true,
  description: "A symptom occurrence; severity 1–5",
  payload: Type.Object(
    {
      name: Type.String(),
      severity: Type.Optional(
        Type.Union([
          Type.Literal(1),
          Type.Literal(2),
          Type.Literal(3),
          Type.Literal(4),
          Type.Literal(5),
        ])
      ),
      duration_min: Type.Optional(Type.Number()),
    },
    { additionalProperties: false }
  ),
};
