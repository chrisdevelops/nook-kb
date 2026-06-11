import type { TObject } from "@sinclair/typebox";

export type KindDef = {
  /** Status vocabulary, or null for statusless kinds. */
  statuses: readonly string[] | null;
  /** Applied on add when --status is omitted (SPEC §4.1); null iff statusless. */
  defaultStatus: string | null;
  description: string;
  /** TypeBox payload schema — serializes directly as JSON Schema. */
  payload: TObject;
};
