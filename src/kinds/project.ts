import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const project: KindDef = {
  statuses: ["active", "paused", "done", "archived"],
  defaultStatus: "active",
  description: "A project; tasks link part_of, docs/notes link about",
  payload: Type.Object(
    {
      client: Type.Optional(Type.String()),
      repo: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  ),
};
