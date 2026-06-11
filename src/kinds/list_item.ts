import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const list_item: KindDef = {
  statuses: ["open", "done"],
  defaultStatus: "open",
  description: "List entry, part_of → list",
  payload: Type.Object(
    { position: Type.Optional(Type.Number()) },
    { additionalProperties: false }
  ),
};
