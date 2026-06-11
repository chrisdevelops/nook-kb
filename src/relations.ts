/**
 * Relation registry (SPEC §3.3): closed set, extended only via spec change.
 * Symmetric rels carry no direction; the CLI canonicalizes src < dst on
 * write so the reverse insert fails DUPLICATE_EDGE instead of
 * double-counting the association.
 */
export const RELATIONS: Record<string, { symmetric: boolean }> = {
  references: { symmetric: false },
  relates_to: { symmetric: true },
  derived_from: { symmetric: false },
  about: { symmetric: false },
  part_of: { symmetric: false },
  blocks: { symmetric: false },
  follows: { symmetric: false },
  evidences: { symmetric: false },
};
