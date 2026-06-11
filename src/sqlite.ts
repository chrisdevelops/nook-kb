import { createRequire } from "node:module";

/**
 * Thin adapter over the runtime's builtin SQLite: bun:sqlite under Bun
 * (the shipped binary, per SPEC §2), node:sqlite under Node (Vitest
 * workers). No third-party driver either way.
 */
export type Db = {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined;
  close(): void;
};

const require = createRequire(import.meta.url);

export function openDatabase(path: string): Db {
  if (process.versions.bun) {
    const { Database } = require("bun:sqlite");
    const db = new Database(path);
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, ...params) => db.query(sql).run(...params),
      all: (sql, ...params) => db.query(sql).all(...params),
      get: (sql, ...params) => db.query(sql).get(...params) ?? undefined,
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path);
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    close: () => db.close(),
  };
}
