# SPEC: Nook Memory — Universal Agent Memory Layer

Status: Draft for review
Owner: Chris Lloyd (Nook)
Last updated: 2026-06-09

---

## 1. Overview

A single, agent-agnostic memory layer backed by one SQLite database, accessed exclusively through a CLI (`mem`). The CLI is documented by a README that doubles as a skill, so any agent — Hermes (persistent assistant via Telegram) or per-project Claude Code sessions — shares identical read/write access with ~225 tokens of context overhead.

The data model is a typed property graph: generic `nodes` carry a `kind` discriminator and a validated JSON payload; `edges` connect nodes with typed relationships. Insight emergence is a function of edge density: the same query, run months apart, returns richer results because graph expansion traverses more connections — not because the query got smarter. This is the Obsidian model (links + tags → emergent structure) applied to a database.

### Goals

- One database, one CLI, one skill, shared by all agents.
- Flexible enough to model: project docs, tasks, source transcripts, distilled insights, people/relationships, calendar-ish events, ideas, lists, symptoms, meals, doctor visits, lab results, income/expenses, subscriptions.
- Connections (edges) accumulate naturally at capture time and via background suggestion, producing compounding retrieval quality.
- Greenfield: this layer ships with a fresh Hermes installation as its sole memory store from day one.
- Reports: medical history export, finance summaries, task views — derivable from the same store.

### Non-goals

- Not an automation platform. The layer stores and retrieves; agents decide what to do.
- No multi-user support, no sync/server in v1. Single machine, single user.
- No UI. Agents and the terminal are the interface. (A future read-only viewer is out of scope here.)
- Not a full calendar/finance replacement. It is a memory of these things, not the system of record for money movement or invitations.
- No vector embeddings in v1 (see Phasing). FTS5 + graph expansion first; add `sqlite-vec` only when lexical retrieval demonstrably falls short.

---

## 2. Core Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | Bun | Existing standard; `bun:sqlite` is fast and built in |
| DB access | `bun:sqlite` directly, no ORM | Heavy use of FTS5, recursive CTEs, generated columns, and triggers; Drizzle adds abstraction without value here |
| Validation | TypeBox + AJV | Existing standard; payload schemas per kind with full type inference |
| IDs | ULID | Sortable, existing standard from `nook` CLI |
| DB location | `$XDG_DATA_HOME/nook/memory.db` (default `~/.local/share/nook/memory.db`) | Matches Hermes layout; every agent on the machine resolves the same path |
| Config | `$XDG_CONFIG_HOME/nook/memory.jsonc` | Flat JSONC config, optional; sane defaults mean zero-config works |
| Process model | No server/daemon; the CLI is the entire runtime | SQLite is embedded — each invocation opens the file, works, exits. WAL + `busy_timeout` handle concurrent agents. Scheduled work (`suggest`, `backup`) is cron/heartbeat invoking the same CLI |
| Package | `@nook/mem`, binary `mem` | Scoped under existing Nook npm presence |
| Output | JSON to stdout by default; `--human` flag for readable output | Agent-first per cli-tool-creator conventions |
| Errors | stderr; exit 0 success, 1 user error, 2 system error | Agents branch on exit codes |
| Migrations | Numbered SQL files applied at startup, tracked in `schema_migrations` | Simplest thing that works |

The CLI never prompts interactively. All input via args, flags, or stdin.

---

## 3. Data Model

### 3.1 DDL

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;   -- concurrent agents: second writer waits, not errors
PRAGMA foreign_keys = ON;

CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,              -- ULID
  kind        TEXT NOT NULL,                 -- registered kind, see §4
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',      -- markdown; wikilinks allowed
  payload     TEXT NOT NULL DEFAULT '{}',    -- JSON, validated per kind
  status      TEXT,                          -- kind-dependent lifecycle (e.g. task: open/done)
  occurred_at TEXT,                          -- ISO 8601; when the thing happened (meal eaten, visit attended)
  created_at  TEXT NOT NULL,                 -- ISO 8601; when captured
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,                          -- soft delete; hard purge via `mem purge`

  -- STORED generated columns over hot payload fields, decided at schema creation.
  -- Post-launch promotions use VIRTUAL columns or expression indexes (see §3.2).
  amount      REAL GENERATED ALWAYS AS (json_extract(payload, '$.amount')) STORED,
  due_at      TEXT GENERATED ALWAYS AS (json_extract(payload, '$.due_at')) STORED
);

CREATE INDEX idx_nodes_kind        ON nodes(kind, occurred_at);
CREATE INDEX idx_nodes_status      ON nodes(kind, status);
CREATE INDEX idx_nodes_occurred_at ON nodes(occurred_at);
CREATE INDEX idx_nodes_due_at      ON nodes(due_at);

CREATE TABLE edges (
  src        TEXT NOT NULL REFERENCES nodes(id),
  dst        TEXT NOT NULL REFERENCES nodes(id),
  rel        TEXT NOT NULL,                  -- registered relation, see §3.3
  weight     REAL NOT NULL DEFAULT 1.0,
  origin     TEXT NOT NULL,                  -- 'agent' | 'wikilink' | 'suggested' | 'user'
  created_at TEXT NOT NULL,
  PRIMARY KEY (src, dst, rel)
);

CREATE INDEX idx_edges_dst ON edges(dst);

CREATE TABLE tags (
  node_id TEXT NOT NULL REFERENCES nodes(id),
  tag     TEXT NOT NULL,                     -- lowercase, hyphenated; '/' allowed for hierarchy (health/sleep)
  PRIMARY KEY (node_id, tag)
);

CREATE INDEX idx_tags_tag ON tags(tag);

CREATE TABLE link_suggestions (
  src        TEXT NOT NULL REFERENCES nodes(id),
  dst        TEXT NOT NULL REFERENCES nodes(id),
  score      REAL NOT NULL,
  reason     TEXT NOT NULL,                  -- e.g. 'fts-similarity', 'shared-tags:health/sleep'
  status     TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'accepted' | 'rejected'
  created_at TEXT NOT NULL,
  PRIMARY KEY (src, dst)
);

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  title, body, tags,
  content='', tokenize='porter unicode61'
);
-- nodes_fts kept in sync by application code on write (contentless table;
-- tags denormalized into the index for tag-aware ranking)

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

Notes:

- `occurred_at` vs `created_at` matters for health and finance: you log yesterday's meal today.
- For time-anchored kinds, `occurred_at` is the canonical query timestamp: events set `occurred_at = starts_at` on write (enforced by the CLI), so the indexed column serves "what's happening today" queries and payload time fields (`starts_at`, `ends_at`) remain detail, never promoted.
- Soft delete keeps edges intact for audit; `mem purge` hard-deletes nodes soft-deleted > N days (default 30) and cascades edges/tags/suggestions.
- Rejected suggestions are retained so the suggester never re-proposes the same pair.

### 3.2 Why one generic node table

Per-kind tables would make each new use case a migration and would fragment the graph (edges across N tables need polymorphic FKs anyway). A kind discriminator + validated JSON payload scales to all listed use cases. The cost (JSON extraction for kind-specific queries) is paid down with generated columns on hot fields.

**Promotion policy.** Payload fields are promoted only when used in WHERE/ORDER BY *and* a real query is measurably slow — never speculatively. Fields read for display are extracted in the SELECT and need no promotion. The mechanism depends on scope:

- **Expression index** (`CREATE INDEX ... ON nodes(json_extract(payload, '$.field'))`) when a single hand-written query (typically one report) needs the speedup. Cheap to add and drop; also the experimentation tool.
- **`VIRTUAL` generated column + index** when the field is core vocabulary for a kind and used across multiple queries. SQLite cannot `ALTER TABLE ADD` a `STORED` generated column, so all post-launch promotions are `VIRTUAL`; indexing a VIRTUAL column materializes its values in the index, so lookup performance is equivalent.
- **`STORED` generated columns** exist only in the initial DDL (`amount`, `due_at`), since adding one later requires a table rebuild.

Expect the promoted set to stay in the single digits permanently; at personal data scale, kind-filtered scans with `json_extract` are fast enough for everything else.

### 3.3 Relation registry

Closed set, extended only via spec change. Free-form `rel` values would fragment traversal.

| rel | Meaning | Typical src → dst |
|---|---|---|
| `references` | Body wikilink or explicit citation | any → any |
| `relates_to` | General association (default for suggestions) | any → any |
| `derived_from` | Distillation provenance | insight → source |
| `about` | Subject linkage | note/event/visit → person/project |
| `part_of` | Containment | task → project, list_item → list, chunk → source |
| `blocks` | Dependency | task → task |
| `follows` | Temporal/causal sequence | visit → visit, event → event |
| `evidences` | Data supporting a correlation/insight | symptom/meal/lab_result → insight |

Edges are directed; traversal treats them as bidirectional with direction available for display.

---

## 4. Kind Registry

Each kind = a TypeBox payload schema + optional status vocabulary + capture conventions. Registered in code (`src/kinds/`), one file per kind, exported from an explicit registry map (no barrel re-exports of anything else). AJV validates payloads on `add` and `update`; invalid payloads are a hard error (exit 1) with the AJV message on stderr.

### 4.1 Initial kinds (v1)

| kind | status vocab | payload (TypeBox, abbreviated) |
|---|---|---|
| `note` | — | `{}` (title/body/tags carry everything) |
| `project` | `active\|paused\|done\|archived` | `{ client?: string, repo?: string }` |
| `doc` | — | `{ project_slug?: string, doc_type?: 'spec'\|'decision'\|'runbook'\|'reference' }` |
| `task` | `open\|in_progress\|done\|dropped` | `{ due_at?: string, priority?: 'low'\|'med'\|'high' }` |
| `source` | — | `{ url?: string, source_type: 'youtube'\|'podcast'\|'article'\|'conversation', author?: string, published_at?: string }` |
| `chunk` | — | `{ position: number }` — transcript segment, `part_of` → source |
| `insight` | — | `{ confidence?: number }` — distilled claim, `derived_from` → source(s) |
| `person` | — | `{ relation?: string, contact?: Record<string,string>, birthday?: string }` |
| `event` | `planned\|done\|cancelled` | `{ starts_at: string, ends_at?: string, location?: string }` |
| `idea` | `raw\|exploring\|committed\|shelved` | `{ category?: 'business'\|'product'\|'goal'\|'other' }` |
| `list` | — | `{ list_type?: 'checklist'\|'collection'\|'ranked' }` |
| `list_item` | `open\|done` | `{ position?: number }` — `part_of` → list |
| `meal` | — | `{ items: string[], meal_type?: 'breakfast'\|'lunch'\|'dinner'\|'snack' }` |
| `symptom` | — | `{ name: string, severity?: 1\|2\|3\|4\|5, duration_min?: number }` |
| `visit` | — | `{ provider: string, specialty?: string, summary_outcome?: string }` |
| `lab_result` | — | `{ panel: string, results: Array<{ marker: string, value: number, unit: string, ref_low?: number, ref_high?: number }> }` |
| `transaction` | — | `{ amount: number, currency: 'CAD', direction: 'income'\|'expense', category?: string, vendor?: string }` |
| `subscription` | `active\|cancelled` | `{ amount: number, currency: 'CAD', cadence: 'monthly'\|'yearly', vendor: string, renews_at?: string }` |

Transcripts: full raw transcript lives on the `source` body if small; long transcripts are **auto-chunked by the CLI on `add`** — when a source body exceeds the chunk budget, `chunk` nodes are created (cut on paragraph/speaker-turn boundaries, greedily packed to ~3k tokens, sequential `position`) with `part_of` edges back to the source, which retains the full body. Agents never chunk manually; the add response reports `chunks_created`.

**Task scoping.** `task` nodes are personal/life tasks, cross-project commitments, and project-level milestones — things that link to people, money, health, and ideas. Fine-grained implementation tasks for code projects stay in their repo's own task system (`.claude/tasks/`); the `project` node's `repo` field is the bridge. Duplicating dev-task churn into the graph is prohibited noise.

**Archival cascade.** Setting a `project` to `archived` transitions its open `part_of` tasks to `dropped` in the same operation (CLI-enforced). Combined with terminal-state exclusion in `query` (§5.2), stale open tasks from dead projects cannot exist, and closed work persists for history and reports without polluting retrieval.

### 4.2 Adding a kind

1. New file `src/kinds/<kind>.ts` with TypeBox schema, status vocab, description.
2. Register in the kind map.
3. If a payload field will be queried/aggregated routinely, add a generated column via migration.
4. CHANGELOG entry; MINOR version bump.

`mem kinds` lists all kinds with their payload schemas as JSON Schema, so an agent can self-discover the contract without the skill enumerating every kind.

---

## 5. Emergence: How Connections Accumulate and Surface

### 5.1 Edge creation (three channels)

1. **Explicit at capture.** `mem add` accepts `--link <id>:<rel>` (repeatable). The skill instructs agents to always attempt at least one link on capture: search first (`mem query`), then add with links to what was found. Capture-time linking is the primary densification mechanism.
2. **Wikilinks.** Body text may contain `[[<id>]]` or `[[<exact title>]]`. On write, the CLI resolves them to `references` edges (origin `wikilink`). Unresolved title links are reported in the JSON response under `unresolved_links` — not an error.
3. **Suggestions.** `mem suggest` (run ad hoc, or via cron/Hermes heartbeat) computes candidate pairs and writes `link_suggestions`. v1 scoring: FTS more-like-this (top terms of node as query) + shared-tag overlap + same-kind temporal proximity for health kinds. `mem suggest --review` emits pending suggestions as JSON; agents accept with `mem link` (origin `suggested`) or `mem suggest reject <src> <dst>`.

### 5.2 Query algorithm

`mem query <text>` is retrieval + graph expansion, not bare search:

1. FTS5 match → top N seed nodes (BM25, weighted title > tags > body).
2. Expand 1–2 hops over edges from seeds (recursive CTE), depth configurable via `--hops` (default 1, max 3).
3. Score each result: `bm25_norm × w1 + edge_weight_path × w2 × hop_decay^hops + recency_decay(occurred_at|created_at) × w3`. Weights in config with tuned defaults.
4. Filters compose: `--kind`, `--tag`, `--status`, `--since/--until` (applied to `occurred_at` falling back to `created_at`), `--limit`. By default, nodes in terminal states (`task: done/dropped`, `project: archived`, `event: cancelled`, `idea: shelved`, soft-deleted anything) are excluded from results and from graph expansion seeds; `--include-closed` lifts this. Closed nodes remain fully visible to `get`, `related`, and reports.
5. Output: JSON array of `{ id, kind, title, snippet, score, hops, via }` where `via` names the edge path for expanded hits — agents can explain *why* a result surfaced.

`mem related <id>` is pure graph neighborhood (no FTS): ranked neighbors at ≤ `--hops`, with shared-tag nodes appended as weak implicit relations. This is the "open the local graph" gesture from Obsidian.

The compounding property: seeds are roughly stable over time, but expansion reaches more as edges accumulate — identical query, richer results.

### 5.3 Reports

`mem report <name>` runs named SQL over the store, JSON or `--human` markdown:

- `medical-history [--since]` — visits, symptoms grouped by name with frequency/severity trends, lab results in chronological panels, current med-adjacent notes. Designed to hand to a new doctor.
- `finance [--month]` — income vs expenses by category, subscription roll-up with projected monthly burn.
- `tasks [--project]` — open/in-progress by due date and priority.
- `health-correlations [--since]` — co-occurrence counts between symptom kinds and meal items/tags within configurable windows (default same-day and next-day). Output is explicitly labeled co-occurrence, not causation; agents interpret.

Reports live in `src/reports/` one file per report; adding a report = MINOR bump.

---

## 6. CLI Surface

```
mem add <kind> --title <t> [--body <md>|--body-stdin] [--payload <json>]
        [--tag <tag>]... [--link <id>:<rel>]... [--status <s>] [--occurred-at <iso>]
mem get <id> [--with-edges] [--with-body]
mem update <id> [--title] [--body|--body-stdin] [--payload-merge <json>]
        [--status] [--occurred-at]
mem delete <id>                # soft delete
mem purge [--older-than <days>]
mem link <src> <dst> <rel> [--weight <n>]
mem unlink <src> <dst> <rel>
mem tag <id> <tag>... | mem untag <id> <tag>...
mem query <text> [--kind]... [--tag]... [--status] [--since] [--until]
        [--hops <0-3>] [--limit <n>] [--include-closed]
mem related <id> [--hops <1-3>] [--limit <n>]
mem suggest [--review | reject <src> <dst>] [--limit <n>]
mem report <name> [report-specific flags] [--human]
mem kinds [<kind>]             # contract self-discovery
mem stats                      # node/edge/tag counts by kind, suggestion backlog
mem export [--kind]... [--since]   # JSONL dump for portability (not the backup mechanism)
mem import <jsonl>             # restore from an export
mem backup [--dest <dir>] [--keep <n>]   # VACUUM INTO timestamped snapshot, rotate to n (default 14)
```

Conventions (per cli-tool-creator): JSON to stdout, errors to stderr, exit 0/1/2, no prompts, `--human` for readable output. `--payload-merge` is a shallow merge then full-schema revalidation. Arg parsing via CAC (existing standard); no other runtime dependencies beyond TypeBox/AJV/CAC/ulid.

### 6.1 Backups

The database file is the backup unit. Because the DB runs in WAL mode, a plain file copy of a live database is unsafe; `mem backup` uses `VACUUM INTO` to produce a consistent, compacted snapshot (`memory-<iso-timestamp>.db`) in `$XDG_DATA_HOME/nook/backups/` by default, pruning to `--keep` most recent. Scheduling is external (cron or Hermes heartbeat). `mem export` JSONL is for portability and migrations, not backup. Continuous replication (Litestream) is a possible later addition and requires no schema or CLI changes.

---

## 7. Skill Packaging

The skill shipped to agents is a README (< 200 words) following the cli-tool-creator template:

- One-sentence purpose.
- The capture discipline: **search before you add; always link what you add** (this single instruction drives graph density).
- The ideation convention: a new idea is an `idea` anchor node; later fragments (characters, features, conflicts, refinements) are `note` children linked `part_of` → the anchor, found by searching first — never body edits on the anchor. Hierarchical tags (`story/<slug>/...`, `biz/<slug>/...`) group constellations.
- Usage block: `add`, `query`, `related`, `update`, `link`, `report`, `kinds`.
- Note that `mem kinds` reveals payload contracts — the README does not enumerate kinds.
- Three examples: capture a linked note, query with hops, log a meal with `--occurred-at`.

The same README serves Hermes (referenced from `AGENTS.md` / a skill under `~/.local/share/nook/skills/`) and Claude Code projects (a thin project skill pointing at the global binary). One contract, every agent.

### 7.1 Schema Evolution Guardrails (Maintenance Agents Only)

The runtime skill says nothing about schema — agents using the CLI have no authority over it and no instructions referencing it. Schema evolution belongs exclusively to the dedicated agent(s) that develop and maintain the `mem` codebase, acting on user request or routine evaluation. These guardrails live in that maintenance skill / system instructions, shipped with the repo and loaded only when working on `mem` itself.

A promotion (new index or generated column) may proceed only when ALL gates pass:

1. **Evidence gate.** A specific, real query is documented as slow — actual timing, reproduced and measured, not vibes. User reports of sluggishness are leads, not evidence.
2. **The three-question test** (§3.2): the field is in WHERE/ORDER BY (not display-only); the query recurs (daily/weekly, not annually); the scanned row set is large enough that JSON extraction is the actual cost (verify with `EXPLAIN QUERY PLAN`).
3. **Escalation order.** First ask if an existing index/column already serves it (e.g. the `occurred_at` convention). Then expression index if a single hand-written query needs it. Only then a `VIRTUAL` generated column, when the field is used across multiple queries. `STORED` is never added post-launch.
4. **Process gate.** Numbered migration + index, CHANGELOG entry in the same commit, MINOR version bump, and the rationale (the measured query) recorded in the migration file's header comment.

Default answer to any promotion proposal is no. The promoted set staying in single digits is a feature, not a limitation.

---

## 8. Testing Strategy

Contract-level TDD at the CLI boundary. Each command is a black box: arguments + stdin in, JSON + exit code out, database state changed. The §6 surface is the component list; the spec sections defining each command's behavior are the contract source.

- **Sessions start from failing contract tests.** For each implementation item, the session first writes the contract tests for the command(s) in scope (derived from this spec), then implements until green. The tests are the definition of done.
- **Test through command handlers in-process** (`handler(args, db) → result`) against a temp database per test — same contract, fast. A small smoke suite spawns the real binary to verify argv parsing, exit codes, and stdout fidelity.
- **Ranking is asserted by ordering properties, not scores** ("title match outranks body-only match"; "terminal-state nodes absent without `--include-closed`"), so weight tuning never rewrites tests.
- **Two pure functions get direct contracts below the CLI layer:** the transcript chunker (text in → chunk array out, boundary rules per §4) and wikilink resolution (body in → edges + `unresolved_links`). All other internals are tested through commands only.
- **Plumbing (scaffold, migrations runner) is tested alongside, not test-first.**
- Vitest, fully local, no API keys, no skips.

The contract suite is the stability guarantee the skill README relies on: any change to a command's output shape is BREAKING and versioned accordingly.

## 9. Phasing

**Phase 1 — Core store + CLI.** Schema, migrations, kind registry, `add/get/update/delete/link/tag/query (FTS only, --hops 0)/kinds/stats/export/import/backup`. Skill README. Hermes capture flows live.

Implementation order — one item per Claude Code session, each starting from failing contract tests (§8) and ending with passing tests, a changelog entry, and a commit:

1. Repo scaffold: Bun project, CAC entry point, config loading (XDG paths), migrations runner + `schema_migrations`.
2. Migration 001: full DDL from §3.1, pragmas, indexes.
3. Kind registry: TypeBox schemas for all §4.1 kinds, AJV validation boundary, `mem kinds`.
4. FTS sync layer: contentless `nodes_fts` write-through on node create/update/delete, tags denormalized.
5. `mem add` end-to-end: payload validation, tags, `--link`, `occurred_at` conventions (event `starts_at` mirror), source auto-chunking (chunker per TDD §5.1).
6. `mem get` / `mem update` (payload-merge + revalidation) / `mem delete` / `mem purge`.
7. `mem link` / `unlink` / `tag` / `untag`, including the project-archival task cascade.
8. `mem query` (FTS-only, `--hops 0`): filters, terminal-state exclusion, `--include-closed`, BM25 weighting, `--human` markdown output.
9. `mem stats` / `mem export` / `mem import` / `mem backup` (VACUUM INTO + rotation).
10. Skill README per §7; tag v0.1.0.

**Phase 2 — Graph retrieval.** Edge expansion in `query`, `related`, wikilink resolution, `suggest` (FTS + tag heuristics). Sessions follow §5 directly; no further breakdown.

**Phase 3 — Reports.** `medical-history`, `finance`, `tasks`, `health-correlations`. One session per report against §5.3; no further breakdown.

**Phase 4 (deferred, criteria-gated) — Embeddings.** Add `sqlite-vec` + an `embeddings` table only if: (a) recall failures on real queries are documented and (b) attributable to vocabulary mismatch FTS cannot bridge. Local embedding model preferred; design decision deferred.

Each phase ships with tests (Vitest, no API keys required — the layer is fully local), CHANGELOG entries, and a tagged release.

## 10. Resolved Decisions (from review)

1. **Events are memory-only.** No calendar sync in the layer. Events double as history; agents coordinate with calendar tooling separately when needed.
2. **Backups are database-file snapshots** via `mem backup` (`VACUUM INTO`), not JSONL exports. See §6.1.
3. **`--human` query output is a markdown list**: title, kind, id, snippet, and edge path (`via`) for hop-expanded results.
4. **Chunk boundaries: paragraph/speaker-turn cuts, greedily packed to ~3k tokens per chunk.** Semantically coherent edges with bounded size.
5. **No server process.** The CLI is the entire runtime; SQLite is embedded. Concurrency between agents handled by WAL + `busy_timeout`.

No open questions remain. Spec is ready for TDD / Phase 1 task breakdown.
