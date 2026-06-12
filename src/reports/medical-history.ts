import { HEALTH_KINDS } from "../kinds";
import type { Db } from "../sqlite";
import { sinceFilter, validateSince } from "./shared";

type VisitPayload = {
  provider: string;
  specialty?: string;
  summary_outcome?: string;
};

type SymptomPayload = {
  name: string;
  severity?: number;
  duration_min?: number;
};

type SymptomOccurrence = {
  id: string;
  occurred_at: string;
  severity: number | null;
  duration_min: number | null;
};

export type MedicalHistoryReport = {
  report: "medical-history";
  since: string | null;
  visits: Array<{
    id: string;
    title: string;
    provider: string;
    specialty: string | null;
    summary_outcome: string | null;
    occurred_at: string;
  }>;
  symptoms: Array<{
    name: string;
    count: number;
    severity_trend: "rising" | "falling" | "stable" | null;
    occurrences: SymptomOccurrence[];
  }>;
  labs: Array<{
    id: string;
    title: string;
    panel: string;
    results: LabMarker[];
    occurred_at: string;
  }>;
  notes: Array<{
    id: string;
    title: string;
    body: string | null;
    occurred_at: string;
  }>;
};

type LabMarker = {
  marker: string;
  value: number;
  unit: string;
  ref_low?: number;
  ref_high?: number;
};

/** First vs last recorded severity; null when fewer than two are recorded. */
function severityTrend(
  occurrences: SymptomOccurrence[]
): "rising" | "falling" | "stable" | null {
  const recorded = occurrences
    .map((o) => o.severity)
    .filter((s): s is number => s !== null);
  if (recorded.length < 2) return null;
  const first = recorded[0]!;
  const last = recorded[recorded.length - 1]!;
  return last > first ? "rising" : last < first ? "falling" : "stable";
}

/** Live nodes of one kind, chronological ascending, optionally since a cutoff. */
function liveRows(db: Db, kind: string, since: string | null) {
  const cutoff = sinceFilter(since);
  return db.all(
    `SELECT id, title, payload, occurred_at, created_at FROM nodes
     WHERE kind = ? AND deleted_at IS NULL${cutoff.sql}
     ORDER BY COALESCE(occurred_at, created_at) ASC`,
    kind,
    ...cutoff.params
  );
}

export function medicalHistory(
  db: Db,
  flags: { since?: string } = {}
): MedicalHistoryReport {
  const since = validateSince(flags.since);

  const visits = liveRows(db, "visit", since).map((r) => {
    const p = JSON.parse(r.payload as string) as VisitPayload;
    return {
      id: r.id as string,
      title: r.title as string,
      provider: p.provider,
      specialty: p.specialty ?? null,
      summary_outcome: p.summary_outcome ?? null,
      occurred_at: (r.occurred_at ?? r.created_at) as string,
    };
  });

  const byName = new Map<string, SymptomOccurrence[]>();
  for (const r of liveRows(db, "symptom", since)) {
    const p = JSON.parse(r.payload as string) as SymptomPayload;
    const occurrences = byName.get(p.name) ?? [];
    occurrences.push({
      id: r.id as string,
      occurred_at: (r.occurred_at ?? r.created_at) as string,
      severity: p.severity ?? null,
      duration_min: p.duration_min ?? null,
    });
    byName.set(p.name, occurrences);
  }
  const symptoms = [...byName.entries()]
    .map(([name, occurrences]) => ({
      name,
      count: occurrences.length,
      severity_trend: severityTrend(occurrences),
      occurrences,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const labs = liveRows(db, "lab_result", since).map((r) => {
    const p = JSON.parse(r.payload as string) as {
      panel: string;
      results: LabMarker[];
    };
    return {
      id: r.id as string,
      title: r.title as string,
      panel: p.panel,
      results: p.results,
      occurred_at: (r.occurred_at ?? r.created_at) as string,
    };
  });

  // "med-adjacent": an edge (either direction) to a live health-kind node,
  // or a health tag — the same health-kind set the suggester uses.
  const notesCutoff = sinceFilter(since, "n.");
  const healthKindMarks = HEALTH_KINDS.map(() => "?").join(", ");
  const notes = db
    .all(
      `SELECT n.id, n.title, n.body, n.occurred_at, n.created_at FROM nodes n
       WHERE n.kind = 'note' AND n.deleted_at IS NULL
         AND (
           EXISTS (
             SELECT 1 FROM edges e
             JOIN nodes h ON h.id = CASE WHEN e.src = n.id THEN e.dst ELSE e.src END
             WHERE (e.src = n.id OR e.dst = n.id)
               AND h.kind IN (${healthKindMarks})
               AND h.deleted_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM tags t
             WHERE t.node_id = n.id
               AND (t.tag = 'health' OR substr(t.tag, 1, 7) = 'health/')
           )
         )${notesCutoff.sql}
       ORDER BY COALESCE(n.occurred_at, n.created_at) ASC`,
      ...HEALTH_KINDS,
      ...notesCutoff.params
    )
    .map((r) => ({
      id: r.id as string,
      title: r.title as string,
      body: (r.body ?? null) as string | null,
      occurred_at: (r.occurred_at ?? r.created_at) as string,
    }));

  return {
    report: "medical-history",
    since,
    visits,
    symptoms,
    labs,
    notes,
  };
}

const day = (iso: string) => iso.slice(0, 10);

/** `--human`: markdown a doctor can read top to bottom (SPEC §5.3). */
export function renderMedicalHistoryHuman(r: MedicalHistoryReport): string {
  const out: string[] = ["# Medical history"];
  if (r.since !== null) out.push(`_since ${r.since}_`);

  out.push("", "## Visits");
  if (r.visits.length === 0) out.push("_none_");
  for (const v of r.visits) {
    const specialty = v.specialty ? ` (${v.specialty})` : "";
    const outcome = v.summary_outcome ? ` — ${v.summary_outcome}` : "";
    out.push(
      `- **${day(v.occurred_at)}** ${v.title} — ${v.provider}${specialty}${outcome}`
    );
  }

  out.push("", "## Symptoms");
  if (r.symptoms.length === 0) out.push("_none_");
  for (const s of r.symptoms) {
    const trend = s.severity_trend ? `, severity ${s.severity_trend}` : "";
    out.push(`- **${s.name}** ×${s.count}${trend}`);
    for (const o of s.occurrences) {
      const sev = o.severity === null ? "" : ` — severity ${o.severity}`;
      out.push(`  - ${day(o.occurred_at)}${sev}`);
    }
  }

  out.push("", "## Lab results");
  if (r.labs.length === 0) out.push("_none_");
  for (const l of r.labs) {
    out.push(`### ${l.panel} — ${day(l.occurred_at)} (${l.title})`);
    for (const m of l.results) {
      const ref =
        m.ref_low !== undefined || m.ref_high !== undefined
          ? ` (ref ${m.ref_low ?? "…"}–${m.ref_high ?? "…"})`
          : "";
      out.push(`- ${m.marker}: ${m.value} ${m.unit}${ref}`);
    }
  }

  out.push("", "## Notes");
  if (r.notes.length === 0) out.push("_none_");
  for (const n of r.notes) {
    const body = n.body ? ` — ${n.body}` : "";
    out.push(`- **${day(n.occurred_at)}** ${n.title}${body}`);
  }

  return out.join("\n");
}
