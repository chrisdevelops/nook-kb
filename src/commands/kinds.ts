import { UserError } from "../errors";
import { KINDS } from "../kinds";

function kindContract(name: string) {
  const def = KINDS[name];
  if (!def) throw new UserError("UNKNOWN_KIND", `unknown kind "${name}"`);
  return {
    kind: name,
    statuses: def.statuses,
    default_status: def.defaultStatus,
    payload_schema: def.payload,
  };
}

export function kindsCommand(kind?: string): unknown {
  return kind === undefined
    ? Object.keys(KINDS).map(kindContract)
    : kindContract(kind);
}
