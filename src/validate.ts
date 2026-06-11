import { Ajv, type ValidateFunction } from "ajv";
import { UserError } from "./errors";
import { KINDS } from "./kinds";

const ajv = new Ajv({ allErrors: false });
const compiled = new Map<string, ValidateFunction>();

/**
 * The single AJV boundary (SPEC §4): payloads are validated against the
 * kind's TypeBox schema on add and update. Throws VALIDATION_FAILED with
 * the AJV message (instancePath included so agents see which field).
 */
export function validatePayload(kind: string, payload: unknown): void {
  let validate = compiled.get(kind);
  if (!validate) {
    const def = KINDS[kind];
    if (!def) throw new UserError("UNKNOWN_KIND", `unknown kind "${kind}"`);
    validate = ajv.compile(def.payload);
    compiled.set(kind, validate);
  }
  if (!validate(payload)) {
    const e = validate.errors?.[0];
    const where = e?.instancePath ? `payload${e.instancePath}` : "payload";
    throw new UserError(
      "VALIDATION_FAILED",
      `${where} ${e?.message ?? "is invalid"}`
    );
  }
}

/** Status must belong to the kind's vocabulary; statusless kinds accept none. */
export function validateStatus(kind: string, status: string): void {
  const def = KINDS[kind];
  if (!def) throw new UserError("UNKNOWN_KIND", `unknown kind "${kind}"`);
  if (def.statuses === null) {
    throw new UserError(
      "INVALID_STATUS",
      `kind "${kind}" has no status vocabulary`
    );
  }
  if (!def.statuses.includes(status)) {
    throw new UserError(
      "INVALID_STATUS",
      `invalid status "${status}" for kind "${kind}" (expected ${def.statuses.join("|")})`
    );
  }
}

/** Payload arrives as a JSON string from the CLI; parse errors are user errors. */
export function parsePayload(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new UserError("INVALID_ARGS", "--payload is not valid JSON");
  }
}
