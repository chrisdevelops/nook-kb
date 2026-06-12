import { Type } from "@sinclair/typebox";
import { scale1to5, type KindDef } from "./kind";

export const activity: KindDef = {
  statuses: null,
  defaultStatus: null,
  health: true,
  description:
    "A physical activity session; name is canonical lowercase (hike, run); effort and enjoyment are independent 1–5 axes",
  payload: Type.Object(
    {
      name: Type.String(),
      duration_min: Type.Optional(Type.Number()),
      distance_km: Type.Optional(Type.Number()),
      effort: Type.Optional(scale1to5),
      enjoyment: Type.Optional(scale1to5),
      weather: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  ),
};
