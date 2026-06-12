import { UserError } from "../errors";
import { nonTerminalStatuses } from "../kinds";
import type { Db } from "../sqlite";
import { resolveNodeRef } from "../wikilinks";

type ProjectRef = { id: string; title: string };

type TaskRow = {
  id: string;
  title: string;
  status: "open" | "in_progress";
  due_at: string | null;
  priority: "low" | "med" | "high" | null;
  projects: ProjectRef[];
};

export type TasksReport = {
  report: "tasks";
  project: ProjectRef | null;
  tasks: TaskRow[];
};

/** `--project`: the wikilink resolution rule, scoped to live projects. */
function resolveProject(db: Db, ref: string): ProjectRef {
  const matches = resolveNodeRef(db, ref, "project");
  if (matches.length > 1) {
    throw new UserError("INVALID_ARGS", `--project "${ref}" is ambiguous`);
  }
  if (matches.length === 0) {
    throw new UserError("NOT_FOUND", `no project "${ref}"`);
  }
  return matches[0]!;
}

export function tasks(db: Db, flags: { project?: string } = {}): TasksReport {
  const project =
    flags.project === undefined ? null : resolveProject(db, flags.project);

  const scopeSql =
    project === null
      ? ""
      : ` AND EXISTS (SELECT 1 FROM edges e
                      WHERE e.src = nodes.id AND e.rel = 'part_of' AND e.dst = ?)`;
  const scopeParams = project === null ? [] : [project.id];

  // non-terminal derives from the registry, so a new task status appears
  // here the same day query stops excluding it
  const live = nonTerminalStatuses("task");
  // due-DATE urgency first (undated last; intra-day times never outrank
  // priority), then priority, then capture order
  const rows = db
    .all(
      `SELECT id, title, status, due_at, payload FROM nodes
       WHERE kind = 'task' AND deleted_at IS NULL
         AND status IN (${live.map(() => "?").join(", ")})${scopeSql}
       ORDER BY due_at IS NULL ASC, substr(due_at, 1, 10) ASC,
                CASE json_extract(payload, '$.priority')
                  WHEN 'high' THEN 0 WHEN 'med' THEN 1 WHEN 'low' THEN 2
                  ELSE 3
                END ASC,
                created_at ASC`,
      ...live,
      ...scopeParams
    )
    .map((r) => {
      const p = JSON.parse(r.payload as string) as { priority?: string };
      const projects = db
        .all(
          `SELECT p.id, p.title FROM edges e
           JOIN nodes p ON p.id = e.dst
           WHERE e.src = ? AND e.rel = 'part_of'
             AND p.kind = 'project' AND p.deleted_at IS NULL
           ORDER BY p.title ASC`,
          r.id
        )
        .map((row) => ({
          id: row.id as string,
          title: row.title as string,
        }));
      return {
        id: r.id as string,
        title: r.title as string,
        status: r.status as TaskRow["status"],
        due_at: (r.due_at ?? null) as string | null,
        priority: (p.priority ?? null) as TaskRow["priority"],
        projects,
      };
    });

  return { report: "tasks", project, tasks: rows };
}

/** `--human`: markdown checklist in report order (SPEC §5.3). */
export function renderTasksHuman(r: TasksReport): string {
  const out: string[] = ["# Tasks"];
  if (r.project !== null) out.push(`_project: ${r.project.title}_`);
  out.push("");
  if (r.tasks.length === 0) out.push("_none open_");
  for (const t of r.tasks) {
    const due = t.due_at ? ` — due ${t.due_at}` : "";
    const priority = t.priority ? ` [${t.priority}]` : "";
    const projects =
      t.projects.length > 0
        ? ` (${t.projects.map((p) => p.title).join(", ")})`
        : "";
    out.push(`- **${t.title}**${priority}${due} — ${t.status}${projects}`);
  }
  return out.join("\n");
}
