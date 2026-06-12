import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

// One node = one regimen; doses taken are never nodes (SPEC §4.1).
export const medication: KindDef = {
  statuses: ["active", "stopped"],
  defaultStatus: "active",
  health: true,
  occurredAtSource: "started_at",
  description:
    "An ongoing medication regimen; occurred_at mirrors started_at, stopped preserves that it ended",
  payload: Type.Object(
    {
      name: Type.String(),
      dose: Type.Optional(Type.String()),
      prescriber: Type.Optional(Type.String()),
      started_at: Type.Optional(Type.String()),
      stopped_at: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  ),
};
