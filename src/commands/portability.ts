import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config";
import type { Context } from "../context";
import { ftsUpsert } from "../fts";
import { nodeTags } from "../nodes";
import type { Db } from "../sqlite";

export type ExportArgs = { kinds: string[]; since?: string };

/**
 * JSONL export: one line per node — soft-deleted included, an export is a
 * faithful copy of everything not yet purged (SPEC §6).
 */
export function exportCommand(db: Db, args: ExportArgs): string {
  const where: string[] = ["1=1"];
  const params: unknown[] = [];
  if (args.kinds.length > 0) {
    where.push(`kind IN (${args.kinds.map(() => "?").join(", ")})`);
    params.push(...args.kinds);
  }
  if (args.since !== undefined) {
    where.push("COALESCE(occurred_at, created_at) >= ?");
    params.push(args.since);
  }
  const rows = db.all(
    `SELECT id, kind, title, body, payload, status, occurred_at, created_at, updated_at, deleted_at
     FROM nodes WHERE ${where.join(" AND ")} ORDER BY id`,
    ...params
  );
  const lines = rows.map((row) =>
    JSON.stringify({
      node: { ...row, payload: JSON.parse(row.payload as string) },
      edges_out: db.all(
        "SELECT dst, rel, weight, origin, created_at FROM edges WHERE src = ? ORDER BY rowid",
        row.id
      ),
      tags: nodeTags(db, row.id as string),
    })
  );

  // suggestion rows (all statuses — rejected pairs must never re-propose
  // after a migration, SPEC §3.1), only when both endpoints are exported
  const exportedIds = new Set(rows.map((r) => r.id as string));
  for (const s of db.all(
    `SELECT src, dst, score, reason, status, created_at
     FROM link_suggestions ORDER BY src, dst`
  )) {
    if (!exportedIds.has(s.src as string) || !exportedIds.has(s.dst as string))
      continue;
    lines.push(JSON.stringify({ suggestion: s }));
  }
  return lines.join("\n");
}

type ExportLine = {
  node?: Record<string, unknown>;
  edges_out?: Record<string, unknown>[];
  tags?: string[];
  suggestion?: Record<string, unknown>;
};

/**
 * Passes inside one transaction (SPEC §6): all nodes, then all edges/tags,
 * then suggestion rows — in-file order never matters. Lines whose id (or
 * suggestion pair) already exists are skipped wholly; edges and suggestions
 * with a missing endpoint are skipped and counted, never an error.
 */
export function importCommand(db: Db, file: string): unknown {
  const allLines: ExportLine[] = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
  const lines = allLines.filter(
    (l): l is Required<Omit<ExportLine, "suggestion">> => l.node !== undefined
  );
  const suggestionLines = allLines.filter((l) => l.suggestion !== undefined);

  let imported = 0;
  let skipped = 0;
  let edgesSkipped = 0;
  let suggestionsSkipped = 0;

  db.exec("BEGIN");
  try {
    const importedIds = new Set<string>();
    for (const line of lines) {
      const n = line.node;
      if (db.get("SELECT 1 AS x FROM nodes WHERE id = ?", n.id)) {
        skipped++;
        continue;
      }
      db.run(
        `INSERT INTO nodes (id, kind, title, body, payload, status, occurred_at, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        n.id,
        n.kind,
        n.title,
        n.body,
        JSON.stringify(n.payload),
        n.status,
        n.occurred_at,
        n.created_at,
        n.updated_at,
        n.deleted_at
      );
      for (const tag of line.tags) {
        db.run("INSERT INTO tags (node_id, tag) VALUES (?, ?)", n.id, tag);
      }
      if (n.deleted_at === null) {
        ftsUpsert(
          db,
          {
            id: n.id as string,
            title: n.title as string,
            body: n.body as string,
          },
          line.tags
        );
      }
      importedIds.add(n.id as string);
      imported++;
    }

    // second pass: edges for imported lines only (skipped lines contribute nothing)
    for (const line of lines) {
      const src = line.node.id as string;
      if (!importedIds.has(src)) continue;
      for (const e of line.edges_out) {
        if (!db.get("SELECT 1 AS x FROM nodes WHERE id = ?", e.dst)) {
          edgesSkipped++;
          continue;
        }
        db.run(
          "INSERT INTO edges (src, dst, rel, weight, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          src,
          e.dst,
          e.rel,
          e.weight,
          e.origin,
          e.created_at
        );
      }
    }
    // third pass: suggestion rows — endpoints must exist, pairs never overwrite
    for (const line of suggestionLines) {
      const s = line.suggestion!;
      const endpointsExist =
        db.get("SELECT 1 AS x FROM nodes WHERE id = ?", s.src) &&
        db.get("SELECT 1 AS x FROM nodes WHERE id = ?", s.dst);
      const pairExists = db.get(
        "SELECT 1 AS x FROM link_suggestions WHERE src = ? AND dst = ?",
        s.src,
        s.dst
      );
      if (!endpointsExist || pairExists) {
        suggestionsSkipped++;
        continue;
      }
      db.run(
        `INSERT INTO link_suggestions (src, dst, score, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        s.src,
        s.dst,
        s.score,
        s.reason,
        s.status,
        s.created_at
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return {
    imported,
    skipped,
    edges_skipped: edgesSkipped,
    suggestions_skipped: suggestionsSkipped,
  };
}

/**
 * WAL-safe snapshot via VACUUM INTO (SPEC §6.1): consistent, compacted,
 * timestamped; prune to the newest --keep. A plain file copy of a live
 * WAL database is unsafe — this is the supported backup path.
 */
export function backupCommand(
  db: Db,
  ctx: Context,
  config: Config,
  args: { dest?: string; keep?: number }
): unknown {
  const dest =
    args.dest ??
    (config.get("backup.dest") as string | null) ??
    join(dirname(ctx.dbPath), "backups");
  const keep = args.keep ?? (config.get("backup.keep") as number);
  mkdirSync(dest, { recursive: true });

  const stamp = ctx.clock().toISOString().replace(/[-:.]/g, "");
  const path = join(dest, `memory-${stamp}.db`);
  db.run("VACUUM INTO ?", path);

  const snapshots = readdirSync(dest)
    .filter((f) => /^memory-.*\.db$/.test(f))
    .sort(); // timestamped names sort chronologically
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    unlinkSync(join(dest, old));
  }

  return { path, kept: Math.min(keep, snapshots.length) };
}
