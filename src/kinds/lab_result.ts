import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const lab_result: KindDef = {
  statuses: null,
  defaultStatus: null,
  description: "Lab panel with marker results and reference ranges",
  payload: Type.Object(
    {
      panel: Type.String(),
      results: Type.Array(
        Type.Object(
          {
            marker: Type.String(),
            value: Type.Number(),
            unit: Type.String(),
            ref_low: Type.Optional(Type.Number()),
            ref_high: Type.Optional(Type.Number()),
          },
          { additionalProperties: false }
        )
      ),
    },
    { additionalProperties: false }
  ),
};
