import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const idea: KindDef = {
  statuses: ["raw", "exploring", "committed", "shelved"],
  defaultStatus: "raw",
  description: "Idea anchor node; fragments link part_of as note children",
  payload: Type.Object(
    {
      category: Type.Optional(
        Type.Union([
          Type.Literal("business"),
          Type.Literal("product"),
          Type.Literal("goal"),
          Type.Literal("other"),
        ])
      ),
    },
    { additionalProperties: false }
  ),
};
