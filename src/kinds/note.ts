import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const note: KindDef = {
  statuses: null,
  defaultStatus: null,
  description: "Freeform note; title/body/tags carry everything",
  payload: Type.Object({}, { additionalProperties: false }),
};
