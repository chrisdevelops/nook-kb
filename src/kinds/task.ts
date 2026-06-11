import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const task: KindDef = {
  statuses: ["open", "in_progress", "done", "dropped"],
  defaultStatus: "open",
  description:
    "Personal/life task, cross-project commitment, or project milestone",
  payload: Type.Object(
    {
      due_at: Type.Optional(Type.String()),
      priority: Type.Optional(
        Type.Union([
          Type.Literal("low"),
          Type.Literal("med"),
          Type.Literal("high"),
        ])
      ),
    },
    { additionalProperties: false }
  ),
};
