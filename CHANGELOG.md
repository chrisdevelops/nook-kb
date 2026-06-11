# Changelog

## [Unreleased]

### Added

- Walking skeleton (#2): in-process `runCommand(argv, ctx)` contract harness with injected Context (deterministic clock/ids per TDD §1) plus a real-binary smoke suite.
- Migrations runner: numbered SQL files, `schema_migrations` tracking, check-and-apply inside `BEGIN IMMEDIATE`; bounded retry on the delete→WAL journal-mode switch (SQLite skips the busy handler on that path, so concurrent first runs raced without it).
- Migration 001: full SPEC §3.1 DDL — nodes (with STORED `amount`/`due_at` generated columns), edges, tags, link_suggestions, contentful FTS5 `nodes_fts`, indexes.
- JSONC config loading per SPEC §2.1: enumerated keys with defaults, unknown keys warn on stderr, malformed file is a system error (exit 2).
- `mem stats`: node counts by kind, edge/tag counts, pending-suggestion backlog.
- SQLite adapter: `bun:sqlite` under Bun (shipped binary), `node:sqlite` under Node (Vitest workers) — no third-party driver.
