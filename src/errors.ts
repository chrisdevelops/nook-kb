/** Closed set per TDD §2.1; extend only via amendment. */
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "UNKNOWN_KIND"
  | "UNKNOWN_REL"
  | "INVALID_STATUS"
  | "DUPLICATE_EDGE"
  | "INVALID_ARGS"
  | "SYSTEM";

/** User error: exit 1, JSON error object on stderr, nothing on stdout. */
export class UserError extends Error {
  constructor(
    public readonly code: Exclude<ErrorCode, "SYSTEM">,
    message: string
  ) {
    super(message);
  }
}
