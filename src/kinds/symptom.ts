import { Type } from "@sinclair/typebox";
import { scale1to5, type KindDef } from "./kind";

export const symptom: KindDef = {
  statuses: null,
  defaultStatus: null,
  health: true,
  description: "A symptom occurrence; severity 1–5",
  payload: Type.Object(
    {
      name: Type.String(),
      severity: Type.Optional(scale1to5),
      duration_min: Type.Optional(Type.Number()),
    },
    { additionalProperties: false }
  ),
};
