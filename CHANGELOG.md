# Changelog

## [Unreleased]

### Added

- Events & transcripts (#8): the event `occurred_at = starts_at` invariant (applies on add, re-fires when starts_at changes via update; explicit `--occurred-at` on events is INVALID_ARGS); the transcript chunker as a direct pure-function contract (paragraph/speaker-turn boundaries, greedy ~3k-token packing, sentence-split fallback, deterministic, exact-slice round-trip); source auto-chunking on `add --body-stdin` (chunk nodes titled "(n/total)", part_of edges, source keeps full body); and query-time chunk dedup — one best chunk per document, source row dropped when its chunks match.

- Full query surface (#7): composable filters (`--kind`/`--tag`/`--status`/`--since`/`--until` on occurred_at→created_at, `--limit` honoring flag > config > default 20), terminal-state exclusion driven by per-kind `terminalStatuses` in the registry (lifted by `--include-closed`; soft-delete exclusion is unconditional), no-text listing mode (recency-ordered, null score/snippet), and `--human` markdown rendering. TDD T8.3 amended: payloads are not FTS-indexed, so the fixture query term moved from payload-only "oatmeal" to title "breakfast".

- Edges & tags (#6): `add --link <id>:<rel>` (transactional — a bad link aborts the whole add), `mem link` (--weight) / `mem unlink`, relation registry with symmetric canonicalization (reverse relates_to → DUPLICATE_EDGE; directional reverses allowed), `mem tag`/`mem untag` (idempotent, full-set response, FTS re-sync), and the project-archival cascade: archiving drops non-terminal part_of tasks one hop, reported as `cascaded` in the update response. Soft-deleted endpoints reject linking.

- Node lifecycle (#5): `mem get` (canonical node, `--with-body`, `--with-edges`), `mem update` (RFC 7386 merge-patch — null deletes the key — with whole-schema revalidation and FTS re-index), `mem delete` (soft, de-indexes), `mem restore` (re-indexes; idempotent on live nodes; NOT_FOUND once purged), `mem purge` (retention window flag > config > default, cascades edges/tags/suggestions/FTS). Soft-deleted nodes are immutable — every mutation fails NOT_FOUND; readable via `get` only. Config precedence contract (T1.1/T1.2) now covered end-to-end via purge.

- Capture & find (#4): `mem add <kind>` with AJV payload validation (strict schemas, VALIDATION_FAILED on bad payloads, whole add is one transaction), status validation + per-kind defaults, tags, `--occurred-at`; contentful-FTS write-through; minimal `mem query <text>` — BM25 weighted title > tags > body, seven-key result contract with highlighted snippets, soft-deleted excluded, empty result is success.

- Kind registry (#3): all 18 SPEC §4.1 kinds as TypeBox schemas (one module per kind, explicit registry map) with status vocabularies and per-kind default statuses. `mem kinds [<kind>]` exposes the contract as JSON Schema; unknown kind is `UNKNOWN_KIND` (exit 1). Payload schemas are strict (`additionalProperties: false`): unknown payload fields will fail validation at `add` rather than being silently stored.

- Walking skeleton (#2): in-process `runCommand(argv, ctx)` contract harness with injected Context (deterministic clock/ids per TDD §1) plus a real-binary smoke suite.
- Migrations runner: numbered SQL files, `schema_migrations` tracking, check-and-apply inside `BEGIN IMMEDIATE`; bounded retry on the delete→WAL journal-mode switch (SQLite skips the busy handler on that path, so concurrent first runs raced without it).
- Migration 001: full SPEC §3.1 DDL — nodes (with STORED `amount`/`due_at` generated columns), edges, tags, link_suggestions, contentful FTS5 `nodes_fts`, indexes.
- JSONC config loading per SPEC §2.1: enumerated keys with defaults, unknown keys warn on stderr, malformed file is a system error (exit 2).
- `mem stats`: node counts by kind, edge/tag counts, pending-suggestion backlog.
- SQLite adapter: `bun:sqlite` under Bun (shipped binary), `node:sqlite` under Node (Vitest workers) — no third-party driver.
