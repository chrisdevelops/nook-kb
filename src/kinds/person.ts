import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const person: KindDef = {
  statuses: null,
  defaultStatus: null,
  description: "A person; notes/events/visits link about",
  payload: Type.Object(
    {
      relation: Type.Optional(Type.String()),
      contact: Type.Optional(Type.Record(Type.String(), Type.String())),
      birthday: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  ),
};
