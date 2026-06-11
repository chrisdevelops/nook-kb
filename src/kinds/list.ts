import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const list: KindDef = {
  statuses: null,
  defaultStatus: null,
  description: "A list; list_item nodes link part_of",
  payload: Type.Object(
    {
      list_type: Type.Optional(
        Type.Union([
          Type.Literal("checklist"),
          Type.Literal("collection"),
          Type.Literal("ranked"),
        ])
      ),
    },
    { additionalProperties: false }
  ),
};
