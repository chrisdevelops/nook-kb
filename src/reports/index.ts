import { UserError } from "../errors";
import type { Db } from "../sqlite";
import { medicalHistory, renderMedicalHistoryHuman } from "./medical-history";

/**
 * SPEC §5.3: `mem report <name>` runs named SQL over the store,
 * JSON by default or `--human` markdown.
 */
export function reportCommand(
  db: Db,
  name: string,
  flags: { since?: string; human?: boolean }
): string {
  if (name === "medical-history") {
    const data = medicalHistory(db, flags);
    return flags.human ? renderMedicalHistoryHuman(data) : JSON.stringify(data);
  }
  throw new UserError("INVALID_ARGS", `unknown report "${name}"`);
}
