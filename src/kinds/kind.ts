import type { TObject } from "@sinclair/typebox";

export type KindDef = {
  /** Status vocabulary, or null for statusless kinds. */
  statuses: readonly string[] | null;
  /** Applied on add when --status is omitted (SPEC §4.1); null iff statusless. */
  defaultStatus: string | null;
  /** Statuses excluded from query results by default (SPEC §5.2). */
  terminalStatuses?: readonly string[];
  /**
   * Member of the health-kind set (SPEC §5.1/§5.3): cross-kind temporal
   * suggestions and med-adjacency both derive from this flag.
   */
  health?: true;
  description: string;
  /** TypeBox payload schema — serializes directly as JSON Schema. */
  payload: TObject;
};
