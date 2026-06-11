import { Type } from "@sinclair/typebox";
import type { KindDef } from "./kind";

export const doc: KindDef = {
  statuses: null,
  defaultStatus: null,
  description: "Project document (spec, decision, runbook, reference)",
  payload: Type.Object(
    {
      project_slug: Type.Optional(Type.String()),
      doc_type: Type.Optional(
        Type.Union([
          Type.Literal("spec"),
          Type.Literal("decision"),
          Type.Literal("runbook"),
          Type.Literal("reference"),
        ])
      ),
    },
    { additionalProperties: false }
  ),
};
