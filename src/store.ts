import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, type Db } from "./sqlite";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

function loadMigrations(): { version: number; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({
      version: Number.parseInt(f, 10),
      sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8"),
    }))
    .sort((a, b) => a.version - b.version);
}

/**
 * The delete→WAL journal-mode switch needs an exclusive lock and SQLite
 * does NOT run the busy handler on that path, so busy_timeout can't cover
 * it. Retry briefly: once any process flips the file to WAL it persists,
 * and every later attempt reads back "wal" instantly.
 */
function enableWal(db: Db): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if (db.get("PRAGMA journal_mode = WAL")?.journal_mode === "wal") return;
    } catch {
      // database is locked mid-switch by a concurrent process
    }
    if (Date.now() > deadline) throw new Error("could not enable WAL mode");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

/**
 * Open the store: pragmas on every connection, then migrations inside
 * BEGIN IMMEDIATE so concurrent invocations serialize (SPEC §2) — the
 * blocked process re-checks schema_migrations after acquiring and no-ops.
 */
export function openStore(dbPath: string, clock: () => Date): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  enableWal(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    const applied = new Set(
      db.all("SELECT version FROM schema_migrations").map((r) => r.version)
    );
    for (const m of loadMigrations()) {
      if (applied.has(m.version)) continue;
      db.exec(m.sql);
      db.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        m.version,
        clock().toISOString()
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return db;
}
