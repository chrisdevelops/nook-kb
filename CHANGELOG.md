# Changelog

## [Unreleased]

### Added

- `report finance [--month]` (#15): income vs expenses grouped by transaction category (missing categories bucket as `uncategorized`, totals cent-rounded, `net` included), plus a subscription roll-up — `monthly_burn` projects active subscriptions with yearly cadences normalized to amount/12, while cancelled ones stay listed with their status. `--month YYYY-MM` scopes transactions to the calendar month on `occurred_at` falling back to `created_at` (malformed values are `INVALID_ARGS`); the roll-up always reflects current state. JSON or `--human` markdown.

- `mem report` (#14): named reports over the store, JSON by default or `--human` markdown; unknown names are `INVALID_ARGS`. First report: `medical-history [--since]` — visits and lab panels in chronological order, symptoms grouped by payload name with frequency and a first-vs-last `severity_trend`, and med-adjacent notes (an edge to a live health-kind node, or a `health`/`health/…` tag — definition added to SPEC §5.3). `--since` filters every section on `occurred_at` falling back to `created_at`; soft-deleted nodes are excluded everywhere, including the adjacency hop.

## [0.2.0] — 2026-06-11

Phase 2: graph retrieval. Wikilinks (#11), query expansion + related (#12), suggester (#13), plus post-review hardening. MINOR: all changes additive over v0.1.0.

### Fixed

- Post-review hardening (review of the Phase 2 diff): the SPEC §5.1 duplicate-edge silent no-op now lives on `createEdge` itself (`ifDuplicate: "keep"`, atomic via `INSERT OR IGNORE`) instead of pre-check SELECTs at call sites — closing a TOCTOU window where a concurrent writer could make `suggest accept` or wikilink resolution fail `DUPLICATE_EDGE` and strand the suggestion row pending. A body wikilinking its own node (by title or id) no longer persists a self-edge (T-W.8). Query expansion now seeds from the top FTS matches only (5× the result limit) per SPEC §5.2 "top N seed nodes", instead of expanding every match of a broad term. Shared path-scoring extracted (`pathScore`/`graphWeights`, used by query and related), `--limit` parsing deduplicated in the router, and the two expansion-relaxed test assertions tightened back to exact result sets.

### Added

- Suggester (#13): `mem suggest` computes candidate pairs into `link_suggestions` (canonical `src < dst`) over three channels — FTS more-like-this (title terms; ≥ 2 distinct terms must land, chunks excluded as mechanical noise), shared-tag overlap, and cross-kind temporal proximity within the health kinds (meal↔symptom etc. inside the `suggest.windows` same-day/next-day windows; same-kind adjacency deliberately excluded). Pairs already connected by any edge are never proposed; rejected pairs are never re-proposed in either direction. `mem suggest review` lists the pending backlog (score-descending); `mem suggest accept <src> <dst>` creates the `relates_to` edge (origin `suggested`, weight 1.0 — the score stays on the suggestion row) and flips the row, handling reversed arguments via canonical pair identity; `mem suggest reject` flips to rejected. `stats.suggestions_pending` reflects the backlog live.

- Graph expansion (#12): `mem query` now expands FTS seeds over edges (`--hops` 1–3, default 1) — expanded hits carry `hops ≥ 1` and a `via` edge path naming every traversed edge, so agents can explain why a result surfaced; scoring composes the configured FTS/edge/recency weights with hop decay (ordering contracted, never values). Terminal-state nodes can't seed and can't appear as results but remain traversable intermediates (`via` may name a closed hub); soft-deleted nodes block traversal entirely. Chunk dedup is now expansion-aware: a matched chunk still wins its family, and chunks dragged in only by expansion never displace a source that matched directly. New `mem related <id>` (`--hops`, `--limit`): pure graph neighborhood, no FTS — ranked edge neighbors (closed nodes fully visible) with shared-tag nodes appended as weak implicit relations (`hops:null`, `via:["shared-tag:<tag>"]`). `query` user filters now compose on the final result set, so expansion can reach nodes the filters keep. T6.5d/T7.4 test over-pins relaxed to top-hit assertions (their TDD wording — "finds it" — already allowed trailing expansion hits).

- Wikilink resolution (#11): body `[[<id>]]` and `[[Exact Title]]` resolve to `references` edges (origin `wikilink`) on add and on body update — title matching is case-insensitive exact against live nodes; ambiguous, unknown, and soft-deleted targets land in the new `unresolved_links` response field (reported, never persisted — creating the target later does not materialize an edge). Body updates diff origin-scoped: vanished links remove only `wikilink` edges, `direct`/`suggested` are never touched, and a wikilink duplicating an existing edge is a silent no-op keeping its origin. The resolver is the second pure-function contract (TDD §5.2, T-W.1–T-W.7); `links_created` in the add response gains wikilink entries.

## [0.1.0] — 2026-06-11

Phase 1: core store + CLI. Skill README shipped (#10); manual acceptance gate passed — a fresh agent session given only the README and the binary captured a linked note (creating an anchor when search found nothing) and retrieved it by query and by get --with-edges, unaided.

### Added

- Portability (#9): `mem export` JSONL (soft-deleted included with their deleted_at — a faithful copy of everything not yet purged; `--kind`/`--since` filters), `mem import` (single transaction, two passes so file order never matters; existing ids skipped wholly; edges with missing endpoints skipped and counted as `edges_skipped`; FTS rebuilt for live nodes), and `mem backup` (`VACUUM INTO` timestamped snapshots with `--keep` rotation, dest from flag > config > `<data>/backups`). `mem stats` now counts live nodes per kind and reports soft-deleted under a separate `deleted` key — resolving the one open PRD question; SPEC §6 and TDD §2.3 updated.

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
