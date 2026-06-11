import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const source: KindDef = {
  statuses: null,
  defaultStatus: null,
  description: "Raw source material (transcript, article); chunks link part_of",
  payload: Type.Object(
    {
      url: Type.Optional(Type.String()),
      source_type: Type.Union([
        Type.Literal("youtube"),
        Type.Literal("podcast"),
        Type.Literal("article"),
        Type.Literal("conversation"),
      ]),
      author: Type.Optional(Type.String()),
      published_at: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  ),
};
