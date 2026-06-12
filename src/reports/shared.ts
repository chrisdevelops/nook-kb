import { UserError } from "../errors";

/**
 * `--since` must be an ISO date or timestamp; prose, other locales, and
 * impossible dates would otherwise string-compare against ISO timestamps
 * and silently mis-filter (exit 0, wrong report).
 */
export function validateSince(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?)?$/.exec(raw);
  // round-trip the date parts: Date.UTC rolls impossible dates (Feb 30 → Mar 2)
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const roundTrip = new Date(Date.UTC(y, mo - 1, d));
  if (
    m === null ||
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() !== mo - 1 ||
    roundTrip.getUTCDate() !== d
  ) {
    throw new UserError(
      "INVALID_ARGS",
      "--since must be an ISO date or timestamp"
    );
  }
  return raw;
}

/**
 * §5.2 effective-timestamp cutoff: occurred_at falling back to created_at.
 * Fragment and bind params travel together so call sites can't desync them.
 */
export function sinceFilter(
  since: string | null,
  alias = ""
): { sql: string; params: string[] } {
  return since === null
    ? { sql: "", params: [] }
    : {
        sql: ` AND COALESCE(${alias}occurred_at, ${alias}created_at) >= ?`,
        params: [since],
      };
}
