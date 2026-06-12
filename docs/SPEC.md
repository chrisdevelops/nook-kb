# SPEC: Nook Memory — Universal Agent Memory Layer

Status: Draft for review (second review round incorporated)
Owner: Chris Lloyd (Nook)
Last updated: 2026-06-10

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
| Migrations | Numbered SQL files applied at startup, tracked in `schema_migrations` | Simplest thing that works. Check-and-apply runs inside one `BEGIN IMMEDIATE` transaction so concurrent invocations (e.g. Hermes heartbeat + a Claude Code session hitting a fresh DB) serialize: the blocked process re-checks after acquiring the lock and no-ops |

The CLI never prompts interactively. All input via args, flags, or stdin.

IDs are opaque TEXT keys: the CLI performs no ULID format validation on id arguments — any id not present in `nodes` is `NOT_FOUND`.

### 2.1 Config keys

`memory.jsonc` is optional; every key has a default. Precedence: **flag > config > default**. Unknown keys produce a warning on stderr (forward compatibility), never an error; a malformed config file is a system error (exit 2).

| Key | Default | Used by |
|---|---|---|
| `query.weights.fts` | tuned default | §5.2 scoring (w1) |
| `query.weights.edge` | tuned default | §5.2 scoring (w2) |
| `query.weights.recency` | tuned default | §5.2 scoring (w3) |
| `query.hop_decay` | tuned default | §5.2 scoring |
| `query.default_limit` | `20` | `query` |
| `suggest.windows` | same-day + next-day | §5.1 suggester, §5.3 health-correlations (shared) |
| `chunk.budget_tokens` | `3000` | source auto-chunking |
| `purge.default_days` | `30` | `purge` |
| `backup.dest` | `$XDG_DATA_HOME/nook/backups/` | `backup` |
| `backup.keep` | `14` | `backup` |

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
  origin     TEXT NOT NULL,                  -- 'direct' | 'wikilink' | 'suggested' (mechanism, see §5.1)
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
  -- suggestions are direction-free: rows are stored canonically with src < dst
  -- (ULID order), enforced on insert, so rejecting (A,B) also covers (B,A)
);

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  node_id UNINDEXED, title, body, tags,
  tokenize='porter unicode61'
);
-- Plain contentful FTS table kept in sync by application code on write.
-- Contentful (not content='') deliberately: normal UPDATE/DELETE, snippet()
-- works, and node_id joins by persistent id (no rowid coupling, which VACUUM
-- would renumber). Body duplication is irrelevant at personal scale.
-- Tags denormalized into the index for tag-aware ranking.

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

Notes:

- `occurred_at` vs `created_at` matters for health and finance: you log yesterday's meal today.
- For time-anchored kinds, `occurred_at` is the canonical query timestamp: the CLI maintains `occurred_at = starts_at` for events and `occurred_at = started_at` for medications as an **invariant** — it applies on `add` and re-fires on any update that changes the source field (a rescheduled event moves with it; a corrected regimen start moves with it). Passing `--occurred-at` explicitly on these kinds (add or update) is `INVALID_ARGS`; the payload time field is the single source of truth. Medication's `started_at` is optional: while absent, `occurred_at` defaults to add-time; the invariant takes over the first time `started_at` is set. Payload time fields (`starts_at`, `ends_at`, `started_at`, `stopped_at`) remain detail, never promoted.
- Soft delete keeps edges intact for audit; `mem restore <id>` reverses it (clears `deleted_at`, re-indexes). Soft-deleted nodes are otherwise immutable: `update`/`link`/`unlink`/`tag`/`untag`/`delete` against one fail `NOT_FOUND`. Rule: deleted = gone, except `get` and `restore`. `mem purge` hard-deletes nodes soft-deleted > N days (default 30) and cascades edges/tags/suggestions; purged nodes cannot be restored.
- Rejected suggestions are retained so the suggester never re-proposes the same pair (in either direction — see the canonical `src < dst` ordering above).

### 3.2 Why one generic node table

Per-kind tables would make each new use case a migration and would fragment the graph (edges across N tables need polymorphic FKs anyway). A kind discriminator + validated JSON payload scales to all listed use cases. The cost (JSON extraction for kind-specific queries) is paid down with generated columns on hot fields.

**Promotion policy.** Payload fields are promoted only when used in WHERE/ORDER BY *and* a real query is measurably slow — never speculatively. Fields read for display are extracted in the SELECT and need no promotion. The mechanism depends on scope:

- **Expression index** (`CREATE INDEX ... ON nodes(json_extract(payload, '$.field'))`) when a single hand-written query (typically one report) needs the speedup. Cheap to add and drop; also the experimentation tool.
- **`VIRTUAL` generated column + index** when the field is core vocabulary for a kind and used across multiple queries. SQLite cannot `ALTER TABLE ADD` a `STORED` generated column, so all post-launch promotions are `VIRTUAL`; indexing a VIRTUAL column materializes its values in the index, so lookup performance is equivalent.
- **`STORED` generated columns** exist only in the initial DDL (`amount`, `due_at`), since adding one later requires a table rebuild.

Expect the promoted set to stay in the single digits permanently; at personal data scale, kind-filtered scans with `json_extract` are fast enough for everything else.

### 3.3 Relation registry

Closed set, extended only via spec change. Free-form `rel` values would fragment traversal.

| rel | Symmetric | Meaning | Typical src → dst |
|---|---|---|---|
| `references` | no | Body wikilink or explicit citation | any → any |
| `relates_to` | **yes** | General association (default for suggestions) | any → any |
| `derived_from` | no | Distillation provenance | insight → source |
| `about` | no | Subject linkage | note/event/visit → person/project |
| `part_of` | no | Containment | task → project, list_item → list, chunk → source |
| `blocks` | no | Dependency | task → task |
| `follows` | no | Temporal/causal sequence | visit → visit, event → event |
| `evidences` | no | Data supporting a correlation/insight | symptom/meal/lab_result → insight |

Edges are directed; traversal treats them as bidirectional with direction available for display. For **symmetric** relations the direction carries no meaning, so the CLI canonicalizes `src < dst` (ULID order) on write — inserting the reverse of an existing symmetric edge correctly fails `DUPLICATE_EDGE` instead of double-counting the association.

---

## 4. Kind Registry

Each kind = a TypeBox payload schema + optional status vocabulary + capture conventions. Registered in code (`src/kinds/`), one file per kind, exported from an explicit registry map (no barrel re-exports of anything else). AJV validates payloads on `add` and `update`; invalid payloads are a hard error (exit 1) with the AJV message on stderr.

### 4.1 Kinds

The launch set (v1) plus the wellness/medication kinds added after v0.4.0 (rationale: ADR-0001).

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
| `mood` | — | `{ rating: 1\|2\|3\|4\|5, labels?: string[] }` |
| `sleep` | — | `{ duration_min: number, quality?: 1\|2\|3\|4\|5, bed_at?: string, woke_at?: string }` |
| `activity` | — | `{ name: string, duration_min?: number, distance_km?: number, effort?: 1\|2\|3\|4\|5, enjoyment?: 1\|2\|3\|4\|5, weather?: string, location?: string }` |
| `measurement` | — | `{ metric: string, value: number, unit: string }` |
| `medication` | `active\|stopped` | `{ name: string, dose?: string, prescriber?: string, started_at?: string, stopped_at?: string }` |

**Default statuses.** Every kind with a status vocabulary declares a default, applied on `add` when `--status` is omitted: `project → active`, `task → open`, `event → planned`, `idea → raw`, `list_item → open`, `subscription → active`, `medication → active`. Status is therefore never null for statusful kinds; statusless kinds always have null status, and passing `--status` to one is `INVALID_STATUS`.

Transcripts: full raw transcript lives on the `source` body if small; long transcripts are **auto-chunked by the CLI on `add`** — when a source body exceeds the chunk budget, `chunk` nodes are created (cut on paragraph/speaker-turn boundaries, greedily packed to ~3k tokens, sequential `position`) with `part_of` edges back to the source, which retains the full body. Chunk titles follow the deterministic convention `<source title> (n/total)` — self-describing in result lists and unique, so title-wikilinks stay resolvable. Both the source body and chunk bodies are FTS-indexed; query-time dedup keeps results clean (§5.2). Agents never chunk manually; the add response reports `chunks_created`.

**Task scoping.** `task` nodes are personal/life tasks, cross-project commitments, and project-level milestones — things that link to people, money, health, and ideas. Fine-grained implementation tasks for code projects stay in their repo's own task system (`.claude/tasks/`); the `project` node's `repo` field is the bridge. Duplicating dev-task churn into the graph is prohibited noise.

**Archival cascade.** Setting a `project` to `archived` transitions its non-terminal `part_of` tasks (`open` **and** `in_progress`) to `dropped` in the same operation (CLI-enforced); terminal tasks (`done`, `dropped`) are untouched. The cascade is one hop — direct `part_of` edges only, no transitive descent. Combined with terminal-state exclusion in `query` (§5.2), stale open tasks from dead projects cannot exist, and closed work persists for history and reports without polluting retrieval.

**Wellness conventions.** All 1–5 fields share one scale grammar (1 = worst, 5 = best for `mood.rating`, `sleep.quality`, `activity.enjoyment`; 1 = lightest, 5 = heaviest for `symptom.severity`, `activity.effort`). `mood.rating` is **valence** — overall how-good-vs-bad; *which* feeling (sad, anxious) is a `labels` entry (canonical lowercase), never a different number. `sleep.occurred_at` = wake time, attributing the night to the morning it ends — adjacent to the day it affects in the temporal channel. `activity.name` and `measurement.metric` are canonical lowercase free strings (vocabulary discipline via the capture skill, like meal items); `measurement.unit` is required so no reading is ever ambiguous; `measurement.occurred_at` = reading time. `medication` is one node per regimen — doses taken are never nodes; a dose change updates the node (or stop + new node when the history matters). Health flags: `mood`, `sleep`, `activity`, `medication` are health kinds; `measurement` deliberately is **not** — scalar readings recur daily, so proximity to anything carries no signal; scalars earn insight through trend analysis, not link suggestions (ADR-0001).

### 4.2 Adding a kind

1. New file `src/kinds/<kind>.ts` with TypeBox schema, status vocab, description.
2. Register in the kind map.
3. If a payload field will be queried/aggregated routinely, add a generated column via migration.
4. CHANGELOG entry; MINOR version bump.

`mem kinds` lists all kinds with their payload schemas as JSON Schema, so an agent can self-discover the contract without the skill enumerating every kind.

---

## 5. Emergence: How Connections Accumulate and Surface

### 5.1 Edge creation (three channels)

Edge `origin` records the **mechanism** that created the edge — `direct`, `wikilink`, or `suggested` — never the actor (the CLI cannot distinguish a human at a terminal from an agent invoking the same binary, so actor identity is unknowable and not recorded).

1. **Explicit at capture.** `mem add` accepts `--link <id>:<rel>` (repeatable), and `mem link` creates edges after the fact; both write origin `direct`. The skill instructs agents to always attempt at least one link on capture: search first (`mem query`), then add with links to what was found. Capture-time linking is the primary densification mechanism.
2. **Wikilinks.** Body text may contain `[[<id>]]` or `[[<exact title>]]`. On write, the CLI resolves them to `references` edges (origin `wikilink`). On body **update**, wikilinks are re-resolved and diffed against existing `origin='wikilink'` edges only: new links add edges, vanished links remove theirs; `direct`/`suggested` edges are never touched. A wikilink duplicating an existing edge (same src/dst/rel) is a silent no-op that keeps the existing origin. Unresolved title links are reported in the JSON response under `unresolved_links` — not an error, and **not persisted**: unlike Obsidian, there are no forward references in v1 — creating the target later does not materialize the edge. The response surfaces the miss while the agent is still in-context, which is when repair is cheapest; persisted forward references are deferred until real loss is observed.
3. **Suggestions.** `mem suggest` (run ad hoc, or via cron/Hermes heartbeat) computes candidate pairs and writes `link_suggestions` (canonical `src < dst`). v1 scoring: FTS more-like-this (top terms of node as query; terms above a document-frequency ceiling — present in more than max(20, 10%) of live non-chunk nodes — are corpus noise and carry no similarity signal) + shared-tag overlap + **cross-kind** temporal proximity within the health kinds (different-kind pairs — meal↔symptom, etc. — inside the same-day/next-day windows shared with the health-correlations report via `suggest.windows`; same-kind proximity is deliberately excluded, as meal↔meal adjacency is daily noise). `mem suggest review` emits pending suggestions as JSON; `mem suggest accept <src> <dst>` creates the edge (origin `suggested`, rel `relates_to`, weight 1.0 — the suggestion's score stays on the suggestion row as provenance) and marks the row accepted; `mem suggest reject <src> <dst>` marks it rejected.

### 5.2 Query algorithm

`mem query [<text>]` is retrieval + graph expansion, not bare search:

1. FTS5 match → top N seed nodes (BM25, weighted title > tags > body).
2. Expand 1–2 hops over edges from seeds (recursive CTE), depth configurable via `--hops` (default 1, max 3).
3. Score each result: `bm25_norm × w1 + edge_weight_path × w2 × hop_decay^hops + recency_decay(occurred_at|created_at) × w3`. Weights in config (§2.1) with tuned defaults.
4. Filters compose: `--kind`, `--tag`, `--status`, `--since/--until` (applied to `occurred_at` falling back to `created_at`), `--limit` (default 20, from `query.default_limit`). By default, nodes in terminal states (`task: done/dropped`, `project: archived`, `event: cancelled`, `idea: shelved`) are excluded from results and from graph expansion seeds, but remain **traversable as intermediate hops** — archiving a hub project hides it without severing the paths through it; `via` may name a closed node. Soft-deleted nodes are excluded everywhere, including traversal. `--include-closed` lifts the terminal-state exclusion (never the soft-delete one). Closed nodes remain fully visible to `get`, `related`, and reports.
5. **Chunk dedup.** When a chunked source and any of its chunks both match, the source row and all but the highest-scoring chunk are dropped — one result per document. The surviving chunk carries its source id (via its `part_of` edge) so agents can widen to the full source.
6. Output: JSON array of `{ id, kind, title, snippet, score, hops, via }` where `via` names the edge path for expanded hits — agents can explain *why* a result surfaced.

`<text>` is optional. Without it, `query` is a pure filtered **listing**: the same filters compose, ordered by `occurred_at` falling back to `created_at`, descending; `score` is null and no snippet highlighting applies. This serves enumeration ("open tasks", "meals this week") and the skill's search-before-add discipline with one command and one output contract.

`mem related <id>` is pure graph neighborhood (no FTS): ranked neighbors at ≤ `--hops`, with shared-tag nodes appended as weak implicit relations. This is the "open the local graph" gesture from Obsidian.

The compounding property: seeds are roughly stable over time, but expansion reaches more as edges accumulate — identical query, richer results.

### 5.3 Reports

`mem report <name>` runs named SQL over the store, JSON or `--human` markdown:

- `medical-history [--since]` — visits, symptoms grouped by name with frequency/severity trends, lab results in chronological panels, current med-adjacent notes. Designed to hand to a new doctor. Med-adjacent: a note with an edge (either direction) to a live health-kind node (the §5.1 set: meal/symptom/visit/lab_result/mood/sleep/activity/medication) or a `health`/`health/…` tag (case-sensitive, like all tag matching). `--since` must be an ISO date or timestamp.
- `finance [--month]` — income vs expenses by category, subscription roll-up with projected monthly burn. `--month` (YYYY-MM) scopes transactions to the calendar month (occurred_at falling back to created_at); the subscription roll-up always reflects current state. Uncategorized transactions bucket as `uncategorized`; cancelled subscriptions are excluded from the burn but stay listed; yearly cadences normalize as amount/12.
- `tasks [--project]` — open/in-progress ordered by due date (the calendar date of `due_at`; undated last) then priority (high > med > low, missing last). `--project` accepts a project id or exact title (case-insensitive, live projects; ambiguous title is an error) and scopes via `part_of` edges; rows carry their live `part_of` projects.
- `health-correlations [--since]` — co-occurrence counts between symptom kinds and meal items/tags within configurable windows (`suggest.windows`, §2.1 — shared with the suggester; default same-day and next-day). Windows are directional here: same-day is the same calendar date, next-day is the symptom on the calendar day **after** the meal — a symptom preceding a meal never counts toward it (the suggester stays symmetric; linking is direction-free). `--since` (ISO, validated) applies to both sides of a pair. Output is explicitly labeled co-occurrence, not causation; agents interpret.

Scope flags are owned per report: passing a flag to a report that does not take it (e.g. `tasks --since`) is `INVALID_ARGS`, never silently ignored.

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
mem restore <id>               # reverse a soft delete (NOT_FOUND if purged)
mem purge [--older-than <days>]
mem link <src> <dst> <rel> [--weight <n>]
mem unlink <src> <dst> <rel>
mem tag <id> <tag>... | mem untag <id> <tag>...
mem query [<text>] [--kind]... [--tag]... [--status] [--since] [--until]
        [--hops <0-3>] [--limit <n>] [--include-closed]   # no <text> = filtered listing
mem related <id> [--hops <1-3>] [--limit <n>]
mem suggest [--limit <n>]      # compute candidate pairs
mem suggest review [--limit <n>]
mem suggest accept <src> <dst> | mem suggest reject <src> <dst>
mem report <name> [report-specific flags] [--human]
mem kinds [<kind>]             # contract self-discovery
mem stats                      # live node counts by kind, edges/tags, suggestion
                               # backlog, plus a separate soft-deleted total
mem export [--kind]... [--since]   # JSONL dump for portability (not the backup mechanism)
mem import <jsonl>             # restore from an export
mem backup [--dest <dir>] [--keep <n>]   # VACUUM INTO timestamped snapshot, rotate to n (default 14)
```

Conventions (per cli-tool-creator): JSON to stdout, errors to stderr, exit 0/1/2, no prompts, `--human` for readable output. `--payload-merge` follows RFC 7386 merge-patch semantics: shallow merge where **null deletes the key**, then full-schema revalidation — optional payload fields are clearable, not write-once. Arg parsing via CAC (existing standard); no other runtime dependencies beyond TypeBox/AJV/CAC/ulid.

`export` includes soft-deleted nodes (with their `deleted_at`) — an export is a faithful copy of everything not yet purged. It also carries `link_suggestions` rows of every status (rejected pairs must never re-propose after a migration, §3.1) as trailing `{ "suggestion": {...} }` lines, but only pairs whose both endpoints are in the exported node set — a `--kind`/`--since` partial export never references nodes it doesn't contain. `import` runs as a single transaction in three passes (all nodes, then all edges/tags, then suggestions), so in-file ordering never matters; an edge whose endpoint exists in neither the file nor the target DB is skipped and counted in the response (`edges_skipped`), not an error, and likewise a suggestion whose endpoint is absent or whose pair already has a row (`suggestions_skipped`).

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

The contract suite is the stability guarantee the skill README relies on. Versioning rule (consistent with §4.2): **additive** changes — new keys in a response, new commands, new kinds, new reports — are MINOR; removing, renaming, retyping, or changing the meaning of anything existing is BREAKING. Agents parsing JSON tolerate new keys; they break on everything else.

## 9. Phasing

**Phase 1 — Core store + CLI.** Schema, migrations, kind registry, `add/get/update/delete/restore/link/tag/query (FTS only, --hops 0)/kinds/stats/export/import/backup`. Skill README. Hermes capture flows live.

Implementation order — one item per Claude Code session, each starting from failing contract tests (§8) and ending with passing tests, a changelog entry, and a commit:

1. Repo scaffold: Bun project, CAC entry point, config loading (XDG paths), migrations runner + `schema_migrations`.
2. Migration 001: full DDL from §3.1, pragmas, indexes.
3. Kind registry: TypeBox schemas for all §4.1 kinds, AJV validation boundary, `mem kinds`.
4. FTS sync layer: contentful `nodes_fts` write-through on node create/update/delete/restore, tags denormalized.
5. `mem add` end-to-end: payload validation, tags, `--link`, `occurred_at` conventions (event `starts_at` mirror), source auto-chunking (chunker per TDD §5.1).
6. `mem get` / `mem update` (merge-patch + revalidation) / `mem delete` / `mem restore` / `mem purge`.
7. `mem link` / `unlink` / `tag` / `untag`, including the project-archival task cascade.
8. `mem query` (FTS-only, `--hops 0`): filters, no-text listing mode, terminal-state exclusion, `--include-closed`, BM25 weighting, chunk dedup, `--human` markdown output.
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
5. **No server process.** The CLI is the entire runtime; SQLite is embedded. Concurrency between agents handled by WAL + `busy_timeout`; the migrations runner serializes via `BEGIN IMMEDIATE` (§2).

A second review round (2026-06-10) resolved 21 further issues in place: contentful FTS (§3.1), chunk dedup at query (§5.2), mechanism-based edge origins + `suggest accept` (§5.1), per-kind default statuses (§4.1), no-text listing (§5.2), `restore` + soft-delete immutability (§3.1), wikilink edge lifecycle and forward-link limitation (§5.1), non-terminal archival cascade (§4.1), event mirror as invariant (§3.1), export/import fidelity (§6), traversal through closed nodes (§5.2), canonical pair identity (§3.3), migration locking (§2), cross-kind suggest heuristic (§5.1), additive-is-MINOR versioning (§8), opaque IDs (§2), chunk titles (§4.1), weight-1.0 channels (§5.1), merge-patch nulls (§6), config enumeration (§2.1), and forward wikilinks as a stated v1 limitation (§5.1).

No open questions remain. Spec is ready for TDD / Phase 1 task breakdown.
