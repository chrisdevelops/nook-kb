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
};

export type { KindDef };
