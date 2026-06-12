import { UserError } from "../errors";
import type { Db } from "../sqlite";
import { finance, renderFinanceHuman } from "./finance";
import { renderTasksHuman, tasks } from "./tasks";
import { medicalHistory, renderMedicalHistoryHuman } from "./medical-history";

export type ReportFlags = {
  since?: string;
  month?: string;
  project?: string;
  human?: boolean;
};

const SCOPE_FLAGS = ["since", "month", "project"] as const;

/** Which scope flags each report owns; anything else is INVALID_ARGS. */
const REPORT_FLAGS: Record<string, readonly (typeof SCOPE_FLAGS)[number][]> = {
  "medical-history": ["since"],
  finance: ["month"],
  tasks: ["project"],
};

/**
 * SPEC §5.3: `mem report <name>` runs named SQL over the store,
 * JSON by default or `--human` markdown. A scope flag belonging to a
 * different report is an error, never silently ignored.
 */
export function reportCommand(
  db: Db,
  name: string,
  flags: ReportFlags
): string {
  const accepted = REPORT_FLAGS[name];
  if (accepted === undefined) {
    throw new UserError("INVALID_ARGS", `unknown report "${name}"`);
  }
  for (const flag of SCOPE_FLAGS) {
    if (flags[flag] !== undefined && !accepted.includes(flag)) {
      throw new UserError(
        "INVALID_ARGS",
        `--${flag} does not apply to the ${name} report`
      );
    }
  }

  if (name === "medical-history") {
    const data = medicalHistory(db, flags);
    return flags.human ? renderMedicalHistoryHuman(data) : JSON.stringify(data);
  }
  if (name === "finance") {
    const data = finance(db, flags);
    return flags.human ? renderFinanceHuman(data) : JSON.stringify(data);
  }
  const data = tasks(db, flags);
  return flags.human ? renderTasksHuman(data) : JSON.stringify(data);
}
