import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const event: KindDef = {
  statuses: ["planned", "done", "cancelled"],
  defaultStatus: "planned",
  terminalStatuses: ["cancelled"],
  occurredAtSource: "starts_at",
  description:
    "Calendar-ish event; occurred_at mirrors starts_at (CLI invariant)",
  payload: Type.Object(
    {
      starts_at: Type.String(),
      ends_at: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  ),
};
