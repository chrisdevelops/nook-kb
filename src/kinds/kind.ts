import { Type, type TObject } from "@sinclair/typebox";

/** The shared 1–5 scale grammar (SPEC §4.1 Wellness conventions). */
export const scale1to5 = Type.Union([
  Type.Literal(1),
  Type.Literal(2),
  Type.Literal(3),
  Type.Literal(4),
  Type.Literal(5),
]);

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
  /**
   * Payload time field mirrored into occurred_at as a CLI invariant
   * (SPEC §3.1): applied on add, re-fired on updates that change it;
   * --occurred-at on such kinds is INVALID_ARGS. If the field is optional
   * and absent, occurred_at stays null (created_at fallback = add-time).
   */
  occurredAtSource?: string;
  description: string;
  /** TypeBox payload schema — serializes directly as JSON Schema. */
  payload: TObject;
};
