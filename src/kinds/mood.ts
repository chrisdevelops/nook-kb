import { Type } from "@sinclair/typebox";
import { scale1to5, type KindDef } from "./kind";

export const mood: KindDef = {
  statuses: null,
  defaultStatus: null,
  health: true,
  description:
    "A point-in-time mood self-report; rating is valence (1 awful – 5 great), which feeling goes in labels",
  payload: Type.Object(
    {
      rating: scale1to5,
      labels: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false }
  ),
};
