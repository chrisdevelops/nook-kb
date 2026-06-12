import { Type } from "@sinclair/typebox";
import { scale1to5, type KindDef } from "./kind";

export const sleep: KindDef = {
  statuses: null,
  defaultStatus: null,
  health: true,
  description:
    "One night's sleep; occurred_at is wake time — the night belongs to the morning it ends",
  payload: Type.Object(
    {
      duration_min: Type.Number(),
      quality: Type.Optional(scale1to5),
      bed_at: Type.Optional(Type.String()),
      woke_at: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  ),
};
