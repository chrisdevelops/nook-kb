import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const visit: KindDef = {
  statuses: null,
  defaultStatus: null,
  description: "Doctor/provider visit; occurred_at is when attended",
  payload: Type.Object(
    {
      provider: Type.String(),
      specialty: Type.Optional(Type.String()),
      summary_outcome: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  ),
};
