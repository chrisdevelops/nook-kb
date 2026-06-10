# TDD: Nook Memory — Contract Test Specification

Status: Draft for review
Companion to: SPEC.md (behavior authority — if this document and SPEC.md disagree, SPEC.md wins and this document gets amended)
Scope: Phase 1 + pure-function contracts. Phase 2 ranking/suggestion tests are deliberately deferred (ordering properties only, written after real data exists).

---

## 1. Harness Conventions

- **One temp database per test.** Created in `beforeEach` via the migrations runner, destroyed after. Never a shared test database — shared state couples tests invisibly. Most tests use a temp file in the OS tmpdir; `backup` tests require file-based DBs (VACUUM INTO needs a source file).
- **In-process handler invocation.** Tests call `runCommand(argv: string[], ctx: Context)` — the same function the binary's entry point calls — and receive `{ stdout: string, stderr: string, exitCode: number }`. No subprocess per test.
- **Smoke suite** (one file, ~5 tests) spawns the actual binary via `Bun.spawn` to verify argv parsing, exit codes, stdout/stderr separation, and `--human` rendering. Everything else is in-process.
- **Determinism via injected Context:**

```typescript
type Context = {
  dbPath: string;
  clock: () => Date;        // test: starts 2026-01-01T00:00:00.000Z, +1s per call
  generateId: () => string; // test: sequential TEST ULIDs (below)
};
```

- **Test ULIDs:** `generateId` yields `TESTID + zero-padded counter` to 26 chars: `TESTID00000000000000000001`, `...02`, etc. Written in this document as `<id:1>`, `<id:2>` in order of generation within a test.
- **Test timestamps:** first write in a test is `2026-01-01T00:00:00.000Z` (written `T+0`), each subsequent clock call +1s (`T+1`, `T+2`...).
- Assertions are deep-equal on parsed JSON, not string comparison (key order never matters).

## 2. Response Contracts

These shapes are the agent-facing API. Any change to them is BREAKING (SPEC §8).

### 2.1 Exit codes and errors

- `0` success. `1` user error (validation failure, unknown id, bad flag). `2` system error (db unreadable, disk full).
- Errors: single JSON object to **stderr**, nothing to stdout:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "payload/amount must be number" } }
```

Codes (closed set, extend via amendment): `VALIDATION_FAILED`, `NOT_FOUND`, `UNKNOWN_KIND`, `UNKNOWN_REL`, `INVALID_STATUS`, `DUPLICATE_EDGE`, `INVALID_ARGS`, `SYSTEM`.

### 2.2 Canonical node object

Returned by `add`, `get`, `update`:

```json
{
  "id": "<ulid>",
  "kind": "task",
  "title": "Invoice Melinda",
  "body_length": 0,
  "payload": { "due_at": "2026-01-15", "priority": "high" },
  "status": "open",
  "tags": ["client/deer-and-dough"],
  "occurred_at": null,
  "created_at": "<iso>",
  "updated_at": "<iso>",
  "deleted_at": null
}
```

- `body` is omitted by default; `body_length` (chars) always present. `get --with-body` and `add`/`update` responses for nodes whose body was just set include `"body"`.
- `get --with-edges` adds: `"edges": { "out": [{ "dst", "rel", "weight", "origin", "created_at" }], "in": [{ "src", "rel", "weight", "origin", "created_at" }] }`.
- `add` additionally returns `"links_created"`: array of `{ "dst", "rel" }` (from `--link` flags; wikilink-origin entries join in Phase 2), and `"chunks_created"`: number (sources only, 0 otherwise).

### 2.3 Other command responses (stdout, exit 0)

| Command | Shape |
|---|---|
| `delete` | `{ "id", "deleted_at" }` |
| `purge` | `{ "purged": n }` |
| `link` | `{ "src", "dst", "rel", "weight", "origin" }` |
| `unlink` | `{ "src", "dst", "rel", "removed": true }` |
| `tag` / `untag` | `{ "id", "tags": [...] }` (full tag set after the operation) |
| `query` | JSON array of `{ "id", "kind", "title", "snippet", "score", "hops", "via" }`. Phase 1: `hops` always `0`, `via` always `null`. `score` is a positive number; tests never assert its value, only presence and ordering. |
| `related` | Phase 2; shape reserved: array of `{ "id", "kind", "title", "hops", "via" }` |
| `kinds` | array of `{ "kind", "statuses": [...] \| null, "payload_schema": <JSON Schema> }`; `kinds <kind>` returns the single object |
| `stats` | `{ "nodes": { "<kind>": n, ... }, "edges": n, "tags": n, "suggestions_pending": n }` |
| `export` | JSONL to stdout: one `{ "node": {...full incl. body...}, "edges_out": [...], "tags": [...] }` per line |
| `import` | `{ "imported": n, "skipped": n }` (skip = id already exists) |
| `backup` | `{ "path": "<dest>/memory-<iso-compact>.db", "kept": n }` |

## 3. Fixtures

Seed helpers compose; the **standard graph fixture** (`seedStandardGraph(ctx)`) used by query/link/stats tests creates, in order:

| # | Node | Notes |
|---|---|---|
| `<id:1>` | `project` "Safekeep Recovery App", status `active`, tag `client/safekeep` | |
| `<id:2>` | `task` "Ship Safekeep v1", status `open`, payload `{"due_at":"2026-02-01","priority":"high"}` | edge `part_of` → `<id:1>` |
| `<id:3>` | `task` "Invoice Safekeep milestone 1", status `done` | edge `part_of` → `<id:1>` |
| `<id:4>` | `person` "Melinda", payload `{"relation":"client"}` | |
| `<id:5>` | `note` "Square delayed capture gotchas", body mentions "payment capture window" | edge `about` → `<id:4>` |
| `<id:6>` | `meal` "Breakfast", payload `{"items":["oatmeal","coffee"]}`, occurred_at `2026-01-01T08:00:00.000Z` | tag `health/food` |
| `<id:7>` | `symptom` payload `{"name":"headache","severity":3}`, occurred_at `2026-01-01T14:00:00.000Z` | tag `health/symptom` |
| `<id:8>` | `transaction` "Safekeep milestone payment", payload `{"amount":2500,"currency":"CAD","direction":"income","category":"client-work"}` | |

## 4. Contract Tests — Phase 1

Numbered `T<item>.<n>` matching SPEC §9 Phase 1 implementation order. Each implementing session writes the tests for its item first (extending with edge cases is encouraged; removing or weakening listed cases requires a TDD amendment).

### Item 2 — Migrations

**T2.1 fresh database applies all migrations.** Invoke any command (e.g. `stats`) against a nonexistent dbPath → db file created, `schema_migrations` contains every version, exit 0.

**T2.2 idempotent.** Run two commands back-to-back → migrations apply once; second run performs no migration writes.

**T2.3 pragmas active.** After init: `journal_mode` is `wal`, `foreign_keys` on.

### Item 3 — Kind registry

**T3.1 list kinds.** `kinds` → array containing all SPEC §4.1 kinds; each entry has `kind`, `statuses` (array or null), `payload_schema` as valid JSON Schema. Exit 0.

**T3.2 single kind.** `kinds task` → object with `"statuses": ["open","in_progress","done","dropped"]` and a `payload_schema` whose `properties` include `due_at` and `priority`.

**T3.3 unknown kind.** `kinds wizard` → exit 1, stderr `{"error":{"code":"UNKNOWN_KIND",...}}`, empty stdout.

### Item 4 — FTS sync

(Verified through `add`/`update`/`delete` + `query`; no direct FTS table access in tests.)

**T4.1 added node is findable.** Add note titled "Tailscale subnet routing" → `query "tailscale"` returns exactly that node.

**T4.2 update re-indexes.** Add note "draft", update title to "Mortgage renewal options" → `query "mortgage"` finds it; `query "draft"` returns `[]`.

**T4.3 delete de-indexes.** Add, then `delete` → `query` for its terms returns `[]`.

**T4.4 tags are searchable.** Node tagged `health/sleep`, no body/title mention of sleep → `query "sleep"` finds it.

### Item 5 — `add`

**T5.1 minimal add.**
Input: `add note --title "Bun macros are compile-time"`
Output: full node object — `kind:"note"`, `payload:{}`, `status:null`, `tags:[]`, `id:<id:1>`, `created_at`/`updated_at` = `T+0`, `links_created:[]`, `chunks_created:0`. Exit 0.

**T5.2 full add.**
Input: `add task --title "Renew passport" --payload '{"due_at":"2026-03-01","priority":"med"}' --tag admin --tag personal --status open --occurred-at 2026-01-01T09:00:00.000Z`
Output: node with all fields populated as given, `tags:["admin","personal"]`.
DB state: `due_at` generated column = `2026-03-01`.

**T5.3 payload validation failure.**
Input: `add transaction --title "Coffee" --payload '{"amount":"four","currency":"CAD","direction":"expense"}'`
Output: exit 1, stderr code `VALIDATION_FAILED`, message contains `amount`. DB state: zero nodes written.

**T5.4 invalid status for kind.** `add task --title x --status someday` → exit 1, `INVALID_STATUS`.

**T5.5 add with links.** Seed standard graph, then `add note --title "Safekeep auth decision" --link <id:1>:part_of --link <id:4>:about`
Output: `links_created:[{"dst":"<id:1>","rel":"part_of"},{"dst":"<id:4>","rel":"about"}]`.
DB: two edge rows, origin `agent`, weight `1.0`.

**T5.6 link to missing node.** `--link TESTID00000000000000000099:about` → exit 1, `NOT_FOUND`, **no node and no edges written** (whole add is one transaction).

**T5.7 unknown rel.** `--link <id:1>:friend_of` → exit 1, `UNKNOWN_REL`, nothing written.

**T5.8 event timestamp convention.** `add event --title "Dentist" --payload '{"starts_at":"2026-01-20T15:00:00.000Z"}'` → response `occurred_at` = `2026-01-20T15:00:00.000Z` (mirrored by CLI per SPEC §3.1 note).

**T5.9 long source auto-chunks.** `add source --title "Pod ep 41" --payload '{"source_type":"podcast"}' --body-stdin` with a ~12k-token body of paragraphs →
Output: `chunks_created` ≥ 3.
DB: chunk nodes with `payload.position` = 1..n, each with `part_of` edge → source; source node retains full body. Each chunk body ≤ chunk budget; every chunk boundary falls on a paragraph boundary (see §5.1 chunker contract — this test asserts wiring, the chunker contract asserts rules).

**T5.10 short source does not chunk.** 500-token body → `chunks_created:0`, no chunk nodes.

### Item 6 — `get` / `update` / `delete` / `purge`

**T6.1 get default.** `get <id:2>` (standard graph) → canonical node, no `body` key, `body_length` present, no `edges` key.

**T6.2 get with edges.** `get <id:2> --with-edges` → `edges.out` contains `{dst:<id:1>,rel:"part_of",...}`, `edges.in:[]`.

**T6.3 get missing / soft-deleted.** Unknown id → exit 1 `NOT_FOUND`. After `delete <id:5>`, `get <id:5>` succeeds and shows non-null `deleted_at` (soft-deleted nodes stay readable; they're excluded from query, not from get).

**T6.4 update merge semantics.** Node payload `{"due_at":"2026-02-01","priority":"high"}`; `update <id> --payload-merge '{"priority":"low"}'` → payload `{"due_at":"2026-02-01","priority":"low"}`, `updated_at` advanced, `created_at` unchanged.

**T6.5 merge causing invalid payload fails whole.** `--payload-merge '{"priority":"urgent"}'` → exit 1 `VALIDATION_FAILED`, stored payload unchanged.

**T6.6 purge.** Delete `<id:5>` at `T+n`; `purge --older-than 0` → `{"purged":1}`; node row, its edges, and tags gone; FTS finds nothing; other nodes intact. `purge` with default window (30d) right after a delete → `{"purged":0}`.

### Item 7 — `link` / `unlink` / `tag` / `untag` / cascade

**T7.1 link.** `link <id:7> <id:6> evidences --weight 0.8` → response echoes fields, origin `user`. (Origin: `user` for direct CLI `link`, `agent` for `add --link`; both are constants in code paths, asserted here.)

**T7.2 duplicate edge.** Same `link` twice → second: exit 1 `DUPLICATE_EDGE`.

**T7.3 unlink missing.** `unlink` a nonexistent triple → exit 1 `NOT_FOUND`.

**T7.4 tag/untag.** `tag <id:5> square payments` → `{"id":"<id:5>","tags":["square","payments"]}`; `untag <id:5> square` → `{"tags":["payments"]}`. Tagging an existing tag is a no-op success (idempotent).

**T7.5 archival cascade.** Standard graph: `update <id:1> --status archived` →
DB: `<id:2>` (open task, part_of project) now `dropped`; `<id:3>` (already done) **unchanged**. Response includes `"cascaded": [{"id":"<id:2>","from":"open","to":"dropped"}]`.

### Item 8 — `query` (FTS-only)

All against standard graph unless noted.

**T8.1 basic match.** `query "payment capture"` → array containing `<id:5>`; each item has all seven contract keys; `hops:0`, `via:null`; `snippet` contains a highlighted term.

**T8.2 kind filter.** `query "safekeep" --kind task` → only task nodes; `<id:1>` (project) absent.

**T8.3 tag + since filters.** `query "oatmeal" --tag health/food --since 2026-01-01 --until 2026-01-02` → `<id:6>`; with `--since 2026-01-02` → `[]` (filter applies to `occurred_at`).

**T8.4 terminal-state exclusion.** `query "safekeep"` → `<id:3>` (done task) absent. `query "safekeep" --include-closed` → present. Archive `<id:1>` → it disappears from default results too.

**T8.5 soft-deleted excluded even with --include-closed.** Delete `<id:5>` → absent from both modes.

**T8.6 ordering property.** Two notes: A titled "kubernetes ingress", B titled "misc" with body mentioning kubernetes once → `query "kubernetes"` returns A before B. (Ordering asserted; scores not.)

**T8.7 limit.** Seed 5 matching notes; `--limit 2` → exactly 2 results.

**T8.8 no results.** `query "zxqv"` → `[]`, exit 0 (empty is success, not error).

**T8.9 human output.** `query "safekeep" --human` → stdout is markdown (smoke suite): begins with a list item, contains title, kind, and id of top hit; not valid JSON.

### Item 9 — `stats` / `export` / `import` / `backup`

**T9.1 stats.** Standard graph → `nodes` counts by kind match seed exactly (e.g. `"task":2`), `edges:3`, `tags:3`, `suggestions_pending:0`.

**T9.2 export/import round-trip.** `export` full → JSONL, one line per non-deleted node, includes full `body`, `edges_out`, `tags`. Fresh second DB: `import` that JSONL → `{"imported":8,"skipped":0}`; `stats` on both DBs identical; `query "payment capture"` works on the copy (FTS rebuilt on import).

**T9.3 import skips existing.** Import same file again → `{"imported":0,"skipped":8}`.

**T9.4 export filters.** `export --kind meal` → exactly one line.

**T9.5 backup.** `backup --dest <tmp> --keep 2` three times (clock advancing) → response `path` exists on disk and is an openable SQLite db containing the data; dest dir holds exactly 2 files (oldest pruned); `kept:2`.

### Item 10 — Skill README

Not contract-tested. Manual gate: a fresh Claude Code session given only the README + binary must complete "capture a linked note, then find it" unaided.

## 5. Pure-Function Contracts

### 5.1 Chunker — `chunkTranscript(body: string, budgetTokens?: number) → Chunk[]`

`Chunk = { position: number, text: string }`. Budget default ~3000 tokens (estimator: chars/4; precision is not the contract).

**T-C.1 under budget → single chunk** equal to input.
**T-C.2 boundaries are paragraph boundaries.** Input of 40 paragraphs (blank-line separated) totaling ~10k tokens → every chunk's text starts/ends at paragraph boundaries; no paragraph split across chunks; concatenation of chunks (with separators restored) round-trips to the original body.
**T-C.3 greedy packing.** No two adjacent chunks could be merged and still fit the budget.
**T-C.4 speaker turns.** Lines matching `/^[A-Z][\w .'-]{0,40}:/` start a turn; turns are treated as paragraphs even without blank lines.
**T-C.5 oversized single paragraph** (one 5k-token paragraph) → split on sentence boundaries as fallback; never mid-word; positions remain sequential.
**T-C.6 deterministic.** Same input twice → identical output.

### 5.2 Wikilink resolution (Phase 2 — pre-specified)

`resolveWikilinks(body: string, db) → { edges: Array<{dst: string}>, unresolved: string[] }`

**T-W.1** `[[<exact ulid>]]` → edge to that id.
**T-W.2** `[[Exact Title]]` → edge when exactly one live node has that title (case-insensitive exact match).
**T-W.3** ambiguous title (two nodes) → no edge, title in `unresolved` (never guess).
**T-W.4** unknown title → in `unresolved`; add still succeeds.
**T-W.5** links to soft-deleted nodes → unresolved.

---

## 6. Deferred (Phase 2 ranking & suggest)

Written after Phase 1 ships and real capture data exists. Constraints already fixed: ordering-property assertions only; suggestion tests assert candidate presence/absence and that rejected pairs are never re-proposed — never score values.
