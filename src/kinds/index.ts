import type { KindDef } from "./kind";
import { note } from "./note";
import { project } from "./project";
import { doc } from "./doc";
import { task } from "./task";
import { source } from "./source";
import { chunk } from "./chunk";
import { insight } from "./insight";
import { person } from "./person";
import { event } from "./event";
import { idea } from "./idea";
import { list } from "./list";
import { list_item } from "./list_item";
import { meal } from "./meal";
import { symptom } from "./symptom";
import { visit } from "./visit";
import { lab_result } from "./lab_result";
import { transaction } from "./transaction";
import { subscription } from "./subscription";
import { mood } from "./mood";
import { sleep } from "./sleep";
import { activity } from "./activity";

/** Explicit registry map (SPEC §4): adding a kind = new file + entry here. */
export const KINDS: Record<string, KindDef> = {
  note,
  project,
  doc,
  task,
  source,
  chunk,
  insight,
  person,
  event,
  idea,
  list,
  list_item,
  meal,
  symptom,
  visit,
  lab_result,
  transaction,
  subscription,
  mood,
  sleep,
  activity,
};

export type { KindDef };

/** The health-kind set (SPEC §5.1) — one definition for suggester + reports. */
export const HEALTH_KINDS = Object.entries(KINDS)
  .filter(([, def]) => def.health)
  .map(([name]) => name);

/** Statuses outside terminalStatuses; [] for statusless kinds. */
export function nonTerminalStatuses(kind: string): string[] {
  const def = KINDS[kind];
  if (!def?.statuses) return [];
  const terminal = def.terminalStatuses ?? [];
  return def.statuses.filter((s) => !terminal.includes(s));
}
