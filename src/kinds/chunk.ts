import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const chunk: KindDef = {
  statuses: null,
  defaultStatus: null,
  description: "Transcript segment, part_of → source; CLI-created on add",
  payload: Type.Object(
    { position: Type.Number() },
    { additionalProperties: false }
  ),
};
