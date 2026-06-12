import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

// Deliberately NOT health-flagged (ADR-0001): daily scalar readings are
// proximate to everything, so the temporal channel would carry no signal.
export const measurement: KindDef = {
  statuses: null,
  defaultStatus: null,
  description:
    "A point-in-time scalar reading; metric is canonical lowercase (water, weight), unit always recorded",
  payload: Type.Object(
    {
      metric: Type.String(),
      value: Type.Number(),
      unit: Type.String(),
    },
    { additionalProperties: false }
  ),
};
