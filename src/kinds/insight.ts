import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const insight: KindDef = {
  statuses: null,
  defaultStatus: null,
  description: "Distilled claim, derived_from → source(s)",
  payload: Type.Object(
    { confidence: Type.Optional(Type.Number()) },
    { additionalProperties: false }
  ),
};
