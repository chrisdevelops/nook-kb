# TDD: Nook Memory — Contract Test Specification

Status: Draft for review (amended 2026-06-10 to match SPEC second review round)
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

These shapes are the agent-facing API. Removing, renaming, retyping, or changing the meaning of any listed field is BREAKING; purely additive keys are MINOR (SPEC §8).

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
- `add` additionally returns `"links_created"`: array of `{ "dst", "rel" }` (`--link` flags first, then wikilink-origin entries), `"unresolved_links"`: array of wikilink targets that did not resolve (SPEC §5.1), and `"chunks_created"`: number (sources only, 0 otherwise).

### 2.3 Other command responses (stdout, exit 0)

| Command | Shape |
|---|---|
| `delete` | `{ "id", "deleted_at" }` |
| `restore` | `{ "id", "deleted_at": null }` |
| `purge` | `{ "purged": n }` |
| `link` | `{ "src", "dst", "rel", "weight", "origin" }` |
| `unlink` | `{ "src", "dst", "rel", "removed": true }` |
| `tag` / `untag` | `{ "id", "tags": [...] }` (full tag set after the operation) |
| `query` | JSON array of `{ "id", "kind", "title", "snippet", "score", "hops", "via" }`. FTS seeds carry `hops:0`, `via:null`; hop-expanded hits carry `hops ≥ 1`, `snippet:null`, and `via`: array of `"<src> -<rel>-> <dst>"` strings naming each traversed edge in path order (stored direction). `score` is a positive number; tests never assert its value, only presence and ordering. No-text listing mode: `score` and `snippet` are `null`, ordering is `occurred_at`→`created_at` descending. *(Amended in Phase 2: hops/via were placeholder `0`/`null` in Phase 1.)* |
| `related` | array of `{ "id", "kind", "title", "hops", "via" }` — no snippet or score. Edge neighbors carry `hops ≥ 1` and the `via` edge path; shared-tag weak relations carry `hops:null` and `via:["shared-tag:<tag>"]`. |
| `suggest` | `{ "created": n, "pending": n }` |
| `suggest review` | array of `{ "src", "dst", "score", "reason", "created_at" }` — pending rows only, score-descending; `reason` e.g. `temporal-proximity:same-day`, `shared-tags:<tag>`, `fts-similarity` |
| `suggest accept` | `{ "src", "dst", "status": "accepted", "edge": { "src", "dst", "rel", "weight", "origin" } }` — src/dst canonical (`src < dst`) regardless of argument order |
| `suggest reject` | `{ "src", "dst", "status": "rejected" }` — canonical likewise |
| `kinds` | array of `{ "kind", "statuses": [...] \| null, "default_status": <s> \| null, "payload_schema": <JSON Schema> }`; `kinds <kind>` returns the single object |
| `stats` | `{ "nodes": { "<kind>": n, ... }, "edges": n, "tags": n, "suggestions_pending": n, "deleted": n }` — kind counts cover live nodes only; soft-deleted nodes appear solely in `deleted` |
| `export` | JSONL to stdout: one `{ "node": {...full incl. body, deleted_at...}, "edges_out": [...], "tags": [...] }` per line; soft-deleted nodes included. Trailing `{ "suggestion": { "src", "dst", "score", "reason", "status", "created_at" } }` lines carry `link_suggestions` of every status whose both endpoints are in the exported node set *(amended for #18)* |
| `import` | `{ "imported": n, "skipped": n, "edges_skipped": n, "suggestions_skipped": n }` (skip = id already exists; edges_skipped = edge endpoint absent from file and target DB; suggestions_skipped = suggestion endpoint absent or pair already present — never overwrites) *(amended for #18)* |
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

### Item 1 — Config (plumbing, tested alongside per §8 — these are the observable contracts)

**T1.1 config respected.** Config file with `purge.default_days: 0`; delete a node, then `purge` (no flag) → `{"purged":1}`.

**T1.2 flag beats config.** Same config; `purge --older-than 365` → `{"purged":0}`.

**T1.3 unknown key is a warning.** Config with `"futureKnob": true` → command succeeds (exit 0), warning on stderr, valid JSON on stdout.

**T1.4 malformed config.** Syntactically invalid JSONC → exit 2, `SYSTEM`.

### Item 2 — Migrations

**T2.1 fresh database applies all migrations.** Invoke any command (e.g. `stats`) against a nonexistent dbPath → db file created, `schema_migrations` contains every version, exit 0.

**T2.2 idempotent.** Run two commands back-to-back → migrations apply once; second run performs no migration writes.

**T2.3 pragmas active.** After init: `journal_mode` is `wal`, `foreign_keys` on.

**T2.4 concurrent first run.** Two simultaneous invocations against the same fresh dbPath (e.g. two `Bun.spawn` of the binary, or two parallel in-process runs) → both exit 0; `schema_migrations` contains each version exactly once (runner wraps check+apply in `BEGIN IMMEDIATE` per SPEC §2).

### Item 3 — Kind registry

**T3.1 list kinds.** `kinds` → array containing all SPEC §4.1 kinds; each entry has `kind`, `statuses` (array or null), `payload_schema` as valid JSON Schema. Exit 0.

**T3.2 single kind.** `kinds task` → object with `"statuses": ["open","in_progress","done","dropped"]`, `"default_status": "open"`, and a `payload_schema` whose `properties` include `due_at` and `priority`. `kinds note` → `"statuses": null`, `"default_status": null`.

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
Output: full node object — `kind:"note"`, `payload:{}`, `status:null`, `tags:[]`, `id:<id:1>`, `created_at`/`updated_at` = `T+0`, `links_created:[]`, `unresolved_links:[]`, `chunks_created:0`. Exit 0.

**T5.2 full add.**
Input: `add task --title "Renew passport" --payload '{"due_at":"2026-03-01","priority":"med"}' --tag admin --tag personal --status open --occurred-at 2026-01-01T09:00:00.000Z`
Output: node with all fields populated as given, `tags:["admin","personal"]`.
DB state: `due_at` generated column = `2026-03-01`.

**T5.3 payload validation failure.**
Input: `add transaction --title "Coffee" --payload '{"amount":"four","currency":"CAD","direction":"expense"}'`
Output: exit 1, stderr code `VALIDATION_FAILED`, message contains `amount`. DB state: zero nodes written.

**T5.4 invalid status for kind.** `add task --title x --status someday` → exit 1, `INVALID_STATUS`. `add note --title x --status open` (statusless kind) → exit 1, `INVALID_STATUS`.

**T5.4b default status.** `add task --title "Renew passport"` (no `--status`) → `status:"open"`. `add event --title "Dentist" --payload '{"starts_at":"2026-01-20T15:00:00.000Z"}'` → `status:"planned"` (defaults per SPEC §4.1).

**T5.5 add with links.** Seed standard graph, then `add note --title "Safekeep auth decision" --link <id:1>:part_of --link <id:4>:about`
Output: `links_created:[{"dst":"<id:1>","rel":"part_of"},{"dst":"<id:4>","rel":"about"}]`.
DB: two edge rows, origin `direct`, weight `1.0`.

**T5.6 link to missing node.** `--link TESTID00000000000000000099:about` → exit 1, `NOT_FOUND`, **no node and no edges written** (whole add is one transaction).

**T5.7 unknown rel.** `--link <id:1>:friend_of` → exit 1, `UNKNOWN_REL`, nothing written.

**T5.8 event timestamp convention.** `add event --title "Dentist" --payload '{"starts_at":"2026-01-20T15:00:00.000Z"}'` → response `occurred_at` = `2026-01-20T15:00:00.000Z` (mirrored by CLI per SPEC §3.1 note).

**T5.8b event mirror is an invariant.** `add event --title x --occurred-at <iso> --payload '{"starts_at":...}'` → exit 1, `INVALID_ARGS` (`starts_at` is the only timestamp knob for events; same for `update`). Rescheduling: `update <event> --payload-merge '{"starts_at":"2026-01-21T15:00:00.000Z"}'` → `occurred_at` follows to the new value.

**T5.9 long source auto-chunks.** `add source --title "Pod ep 41" --payload '{"source_type":"podcast"}' --body-stdin` with a ~12k-token body of paragraphs →
Output: `chunks_created` ≥ 3.
DB: chunk nodes with `payload.position` = 1..n, titled `Pod ep 41 (1/n)` … `(n/n)` (SPEC §4.1 convention), each with `part_of` edge → source; source node retains full body. Each chunk body ≤ chunk budget; every chunk boundary falls on a paragraph boundary (see §5.1 chunker contract — this test asserts wiring, the chunker contract asserts rules).

**T5.10 short source does not chunk.** 500-token body → `chunks_created:0`, no chunk nodes.

### Item 6 — `get` / `update` / `delete` / `restore` / `purge`

**T6.1 get default.** `get <id:2>` (standard graph) → canonical node, no `body` key, `body_length` present, no `edges` key.

**T6.2 get with edges.** `get <id:2> --with-edges` → `edges.out` contains `{dst:<id:1>,rel:"part_of",...}`, `edges.in:[]`.

**T6.3 get missing / soft-deleted.** Unknown id → exit 1 `NOT_FOUND`. After `delete <id:5>`, `get <id:5>` succeeds and shows non-null `deleted_at` (soft-deleted nodes stay readable; they're excluded from query, not from get).

**T6.4 update merge semantics.** Node payload `{"due_at":"2026-02-01","priority":"high"}`; `update <id> --payload-merge '{"priority":"low"}'` → payload `{"due_at":"2026-02-01","priority":"low"}`, `updated_at` advanced, `created_at` unchanged.

**T6.5 merge causing invalid payload fails whole.** `--payload-merge '{"priority":"urgent"}'` → exit 1 `VALIDATION_FAILED`, stored payload unchanged.

**T6.5b merge null deletes key (RFC 7386).** Node payload `{"due_at":"2026-02-01","priority":"high"}`; `update <id> --payload-merge '{"due_at":null}'` → payload `{"priority":"high"}` (key absent, not null); revalidation passes since `due_at` is optional.

**T6.5c soft-deleted nodes are immutable.** After `delete <id:5>`: `update <id:5> --title x`, `tag <id:5> t`, `link <id:5> <id:4> about`, `link <id:4> <id:5> about`, and a second `delete <id:5>` → each exit 1 `NOT_FOUND`. `get` still succeeds (T6.3).

**T6.5d restore.** `delete <id:5>` then `restore <id:5>` → `{"id":"<id:5>","deleted_at":null}`; node mutable again; `query "payment capture"` finds it again (re-indexed). `restore` on a live node is an idempotent no-op success (same response shape, matching T7.4's tag idempotency). `restore` on an unknown or purged id → exit 1 `NOT_FOUND`.

**T6.6 purge.** Delete `<id:5>` at `T+n`; `purge --older-than 0` → `{"purged":1}`; node row, its edges, and tags gone; FTS finds nothing; other nodes intact. `purge` with default window (30d) right after a delete → `{"purged":0}`.

### Item 7 — `link` / `unlink` / `tag` / `untag` / cascade

**T7.1 link.** `link <id:7> <id:6> evidences --weight 0.8` → response echoes fields, origin `direct`. (Origin records mechanism per SPEC §5.1: `direct` for both CLI `link` and `add --link`; `wikilink` and `suggested` come from their own channels.)

**T7.2 duplicate edge.** Same `link` twice → second: exit 1 `DUPLICATE_EDGE`.

**T7.2b symmetric canonicalization.** `link <id:4> <id:5> relates_to` then `link <id:5> <id:4> relates_to` → second: exit 1 `DUPLICATE_EDGE` (symmetric rels stored canonically src<dst per SPEC §3.3). Directional control: `link <id:5> <id:4> about` after `link <id:4> <id:5> about` → both succeed (reverse of a directional rel is a different statement).

**T7.3 unlink missing.** `unlink` a nonexistent triple → exit 1 `NOT_FOUND`.

**T7.4 tag/untag.** `tag <id:5> square payments` → `{"id":"<id:5>","tags":["square","payments"]}`; `untag <id:5> square` → `{"tags":["payments"]}`. Tagging an existing tag is a no-op success (idempotent).

**T7.5 archival cascade.** Standard graph plus one extra task `in_progress` linked `part_of` → `<id:1>`: `update <id:1> --status archived` →
DB: `<id:2>` (open) and the in_progress task both now `dropped`; `<id:3>` (already done) **unchanged** (cascade covers all non-terminal statuses, one hop, per SPEC §4.1). Response includes `"cascaded"` listing each transition as `{"id","from","to"}`.

### Item 8 — `query` (FTS-only)

All against standard graph unless noted.

**T8.1 basic match.** `query "payment capture"` → array containing `<id:5>`; each item has all seven contract keys; `hops:0`, `via:null`; `snippet` contains a highlighted term.

**T8.2 kind filter.** `query "safekeep" --kind task` → only task nodes; `<id:1>` (project) absent.

**T8.3 tag + since filters.** `query "breakfast" --tag health/food --since 2026-01-01 --until 2026-01-02` → `<id:6>`; with `--since 2026-01-02` → `[]` (filter applies to `occurred_at`). *(Amended: originally queried "oatmeal", which lives only in the meal payload — payloads are not FTS-indexed per SPEC §3.1; the query term must hit title/body/tags.)*

**T8.4 terminal-state exclusion.** `query "safekeep"` → `<id:3>` (done task) absent. `query "safekeep" --include-closed` → present. Archive `<id:1>` → it disappears from default results too.

**T8.5 soft-deleted excluded even with --include-closed.** Delete `<id:5>` → absent from both modes.

**T8.6 ordering property.** Two notes: A titled "kubernetes ingress", B titled "misc" with body mentioning kubernetes once → `query "kubernetes"` returns A before B. (Ordering asserted; scores not.)

**T8.7 limit.** Seed 5 matching notes; `--limit 2` → exactly 2 results.

**T8.8 no results.** `query "zxqv"` → `[]`, exit 0 (empty is success, not error).

**T8.9 human output.** `query "safekeep" --human` → stdout is markdown (smoke suite): begins with a list item, contains title, kind, and id of top hit; not valid JSON.

**T8.10 no-text listing.** `query --kind task --status open` (no text) → exactly the open tasks, `score:null`, `snippet:null`, ordered by `occurred_at` falling back to `created_at` descending. `query --kind meal --since 2026-01-01` → `<id:6>`. Bare `query` → at most 20 results (default limit).

### Item 9 — `stats` / `export` / `import` / `backup`

**T9.1 stats.** Standard graph → `nodes` counts by kind match seed exactly (e.g. `"task":2`), `edges:3`, `tags:3`, `suggestions_pending:0`.

**T9.2 export/import round-trip.** Standard graph with `<id:5>` soft-deleted: `export` full → JSONL, one line per node **including the soft-deleted one** (its `deleted_at` set — export is a faithful copy of everything not yet purged). Fresh second DB: `import` that JSONL → `{"imported":8,"skipped":0,"edges_skipped":0,"suggestions_skipped":0}`; `stats` on both DBs identical; `<id:5>` is soft-deleted in the copy too; `query "safekeep"` works on the copy (FTS rebuilt on import). Import is order-independent: edges resolve in a second pass, so a node's `edges_out` may reference nodes later in the file. *(Response shape amended for #18.)*

**T9.2b dangling edge skipped.** Hand-craft a JSONL line whose `edges_out` references an id absent from both the file and the target DB → import succeeds, `edges_skipped:1`, the node itself imported.

**T9.2c suggestion round-trip (#18).** Seeded graph with a pending backlog and one rejected pair: export → import to a fresh DB → `suggestions_skipped:0`, `stats.suggestions_pending` identical across the pair, and re-running `suggest` on the copy never re-proposes the rejected pair (§3.1's retention promise survives migration).

**T9.2d dangling suggestion skipped (#18).** A `{ "suggestion": ... }` line whose endpoint is absent from file and target DB → import succeeds, `suggestions_skipped:1`. A `--kind` partial export carries no suggestion whose other endpoint falls outside the exported set (mutation-verified on the export filter).

**T9.3 import skips existing.** Import same file again → `{"imported":0,"skipped":8,"edges_skipped":0,"suggestions_skipped":0}`.

**T9.4 export filters.** `export --kind meal` → exactly one line.

**T9.5 backup.** `backup --dest <tmp> --keep 2` three times (clock advancing) → response `path` exists on disk and is an openable SQLite db containing the data; dest dir holds exactly 2 files (oldest pruned); `kept:2`.

### Item 10 — Skill README

Not contract-tested. Manual gate: a fresh Claude Code session given only the README + binary must complete "capture a linked note, then find it" unaided.

### Item 11 — `query` graph expansion (`--hops`, Phase 2)

**T11.1 default 1-hop expansion.** Standard graph, `query "payment capture"` → `<id:5>` (seed, `hops:0`, `via:null`) then `<id:4>` (`hops:1`, `via:["<id:5> -about-> <id:4>"]`, `snippet:null`, positive score).

**T11.2 depth bound + full path.** Note linked `derived_from` → `<id:4>` sits 2 hops from the seed: absent at `--hops 1`, present at `--hops 2` with `hops:2` and a two-element `via` in path order. **T11.2b** `--hops` outside integer 1..3 → `INVALID_ARGS`.

**T11.3 traversal through closed.** Two live notes `part_of` an archived project: querying one finds the other at `--hops 2` (`via` names the archived hub); the hub itself is never a result. `--include-closed` lifts the result-level exclusion (hub appears, `hops:1`).

**T11.4 soft-deleted block traversal.** Chain A—deleted—B: B unreachable, the deleted node absent as seed/result/intermediate, with and without `--include-closed`.

**T11.5 ordering property.** Seed above 1-hop above 2-hop (hop decay); never score values.

**T11.6 chunk dedup under expansion.** Term unique to one chunk → exactly that chunk (source and expansion-dragged siblings deduped). Tag matching only the source → exactly the source (dragged chunks never displace the real match). One row per document either way.

### Item 12 — `related` (Phase 2)

**T12.1 reserved shape.** Standard graph, `related <id:1>` → `<id:2>` and `<id:3>` (closed nodes fully visible here), each exactly `{ id, kind, title, hops, via }`, `hops:1`, `via` naming the edge.

**T12.2 depth, ordering, limit.** Default depth 1; `--hops 2` reaches 2-hop neighbors ranked after 1-hop ones; `--limit` truncates.

**T12.3 shared-tag weak relations.** Nodes sharing a tag with the root append after edge neighbors with `hops:null`, `via:["shared-tag:<tag>"]`.

**T12.4 soft-deleted.** Deleted root → `NOT_FOUND`; deleted nodes absent as neighbors and as weak relations.

### Item 13 — suggester (Phase 2)

Per §6: candidate presence/absence and lifecycle only — never score values.

**T13.1 cross-kind temporal proximity.** Standard graph (meal `<id:6>` and symptom `<id:7>` same day) → `suggest` creates ≥ 1; `review` lists the canonical pair with a `same-day` reason.

**T13.2 windows and the same-kind exclusion.** meal↔meal same-day never proposed; meal → next-day symptom proposed (`next-day` reason); two days out proposed by no window; symptom↔symptom adjacent days also excluded.

**T13.3 shared-tag overlap.** Two live notes sharing a tag → proposed, reason `shared-tags:<tag>`; no-overlap nodes and soft-deleted nodes are never candidates.

**T13.4 FTS similarity.** Titles sharing ≥ 2 distinct terms → proposed, reason `fts-similarity`; one shared common word is not similarity; chunks never participate (sibling titles are mechanically near-identical and `part_of` already binds the family).

**T13.5 existing edge suppresses.** A pair connected by any edge (either direction) is not proposed; `created:0` when nothing else qualifies.

**T13.6 accept.** With **reversed arguments**: edge `{src, dst, rel:"relates_to", weight:1.0, origin:"suggested"}` created on the canonical pair, row flipped (gone from `review`, `suggestions_pending` decrements), re-running `suggest` does not re-propose (the edge now suppresses). Unknown pair → `NOT_FOUND`.

**T13.7 reject.** With reversed arguments: row rejected; re-running `suggest` never re-proposes the pair in either direction; no edge appears.

### Item 14 — `report medical-history` (Phase 3)

Contracts from issue #14 ACs over SPEC §5.3. Per §6: ordering properties and presence/absence only. The trend label is deterministic (first vs last recorded severity), so it is contracted by value. Note: every kind this report reads (`visit`, `symptom`, `lab_result`, `note`) is status-less, so §5.2's closed-nodes-visible-to-reports rule is vacuous here — lifecycle coverage is soft-delete only.

**T14.1 visits.** Two visits added out of chronological order → `visits` ascending by `occurred_at` falling back to `created_at`, each row carrying `provider` plus `specialty`/`summary_outcome` (`null` when absent from the payload).

**T14.2 symptom grouping.** Grouped by payload `name`, never title; groups ordered count-descending (name ascending as tiebreak); occurrences chronological with `severity:null` when unrecorded; `severity_trend` is `rising`/`falling`/`stable` comparing first vs last recorded severity, `null` with fewer than two recordings.

**T14.3 labs.** `lab_result` nodes as chronological panels; `panel` and the `results` marker rows (value/unit/ref bounds) pass through intact.

**T14.4 med-adjacent notes.** A note qualifies via an edge (either direction) to a **live** health-kind node (`meal`/`symptom`/`visit`/`lab_result` — the suggester's set, §5.1) or a `health`/`health/…` tag — **case-sensitive**, like every other tag comparison (`Health/meds` does not qualify); notes with neither never appear. Output rows carry `body` (the content is the point of a doctor handover).

**T14.5 `--since`.** `COALESCE(occurred_at, created_at) >= cutoff` applied to every section; symptom counts and trends reflect the filtered window only; `since` is echoed in the response (`null` without the flag).

**T14.6 soft-deleted.** Excluded from every section; a note whose only health link points at a soft-deleted node is no longer med-adjacent. (Pin over clauses written alongside earlier cycles — verified by mutation: dropping the adjacency `deleted_at` guard fails it.)

**T14.7 `--human`.** Markdown, not JSON: Visits / Symptoms / Lab results / Notes sections naming the underlying data.

**T14.8 unknown report.** `report no-such-report` → `INVALID_ARGS`, exit 1.

**T14.9 foreign scope flags rejected (post-review).** A scope flag belonging to a different report (`medical-history --month/--project`, `finance --since/--project`, `tasks --since/--month`) → `INVALID_ARGS`, never silently ignored.

**T14.10 `--since` validation (post-review).** Prose, non-ISO locales, and impossible dates (`march`, `05/01/2026`, `2026-13-01`, `2026-02-30`) → `INVALID_ARGS`; ISO date-only and full timestamps are accepted and echoed.

### Item 15 — `report finance` (Phase 3)

Contracts from issue #15 ACs over SPEC §5.3. Money values are contracted exactly (cent-rounded arithmetic, not heuristic). Subscription `cancelled` is a plain status, not terminal — the report reads it directly.

**T15.1 category split.** Income and expenses each total their transactions and group by payload `category` (missing → `uncategorized`), ordered total-descending (category ascending as tiebreak); `net = income.total − expenses.total`.

**T15.2 `--month`.** `YYYY-MM` scopes transactions to the calendar month of `occurred_at` falling back to `created_at`; `month` echoed (`null` without the flag); empty directions yield `total: 0` and `by_category: []`; malformed values (`2026-13`, `2026-3`, a full date, prose) → `INVALID_ARGS`.

**T15.3 subscription burn.** `monthly_burn` sums **active** subscriptions' `monthly_equivalent` (monthly = amount; yearly = amount/12, cent-rounded); cancelled subscriptions are excluded from the burn but stay in `items` with their status; items order active-first, then monthly_equivalent descending (vendor as tiebreak). The roll-up reflects current state — `--month` never filters it.

**T15.4 soft-deleted.** Deleted transactions and subscriptions appear nowhere — totals, categories, burn, items. (Pin — verified by mutation: dropping the subscription `deleted_at` guard fails it.)

**T15.5 `--human`.** Markdown, not JSON: Income / Expenses / Subscriptions sections naming categories, vendors, and the month scope.

**T15.6 ordering on displayed totals (post-review).** Category ordering applies to the cent-rounded totals the report emits, not raw float sums: categories displaying equal totals (REAL residue like 0.1+0.2 vs 0.3) honor the category-ascending tiebreak.

### Item 16 — `report tasks` (Phase 3)

Contracts from issue #16 ACs over SPEC §5.3. Per §6: ordering asserted as properties over ids, never scores.

**T16.1 non-terminal only.** `open` and `in_progress` tasks appear with `status`, `due_at`, `priority` (`null` when the payload omits them); `done`/`dropped` never do.

**T16.2 ordering.** `due_at` ascending with undated tasks last; within a date, priority `high > med > low` with missing priority last; capture order (`created_at`) as the stable tiebreak.

**T16.8 date precision (post-review).** "Within a date" means the calendar date (first 10 chars of `due_at`): when due_at values carry times, priority still decides inside the same date — intra-day times never outrank priority.

**T16.3 `--project` scope.** Accepts a project id or an exact title (case-insensitive, live projects — the wikilink rule); scoping follows `part_of` edges, so unrelated and project-less tasks drop out; the resolved `{id, title}` is echoed as `project` (`null` unscoped); every task row carries `projects` (its live `part_of` project neighbors, title-ascending; `[]` when none).

**T16.4 resolution errors.** Unknown id/title → `NOT_FOUND`; a title matching more than one live project → `INVALID_ARGS`.

**T16.5 archival cascade.** Archiving a project (Item 7 cascade flips its open/in_progress `part_of` tasks to `dropped`) removes those tasks from the report; the archived project itself still resolves for `--project` (closed nodes stay visible to reports, §5.2) — the scope is just empty.

**T16.6 soft-deleted.** Deleted tasks never appear (verified by mutation: dropping the `deleted_at` guard fails it); a deleted project no longer resolves for `--project` (`NOT_FOUND`) and vanishes from rows' `projects`.

**T16.7 `--human`.** Markdown, not JSON, naming title, due date, priority, status, and project scope.

### Item 17 — `report health-correlations` (Phase 3)

Contracts from issue #17 ACs over SPEC §5.3. Counts are exact co-occurrence tallies, not heuristic scores, so they are contracted by value. This slice also promoted the health-kind set into the kinds registry (`KindDef.health`, exported `HEALTH_KINDS`) — one definition drives the suggester, med-adjacency, and this report — and derived the tasks report's non-terminal statuses from the registry (`nonTerminalStatuses`), and extracted the wikilink/`--project` resolution rule into `resolveNodeRef`.

**T17.1 same-day counts.** Symptom occurrences × meal items tally per (symptom payload `name`, item) pair — two same-day meals sharing an item count twice; ordered total-descending (symptom, exposure ascending as tiebreaks); the response carries `windows` and a `note` labeling output co-occurrence, not causation.

**T17.2 directional next-day.** A symptom on the calendar day **after** a meal counts `next-day`; a symptom the day before, or two days out, never counts. (Mutation-verified: a symmetric ABS window fails it. The suggester stays symmetric — linking is direction-free; the report is directional by §5.3.)

**T17.3 shared window config.** `suggest.windows` drives the report: `["same-day"]` drops next-day pairs entirely (mutation-verified) and `windows` echoes the config — one key drives suggester and report.

**T17.4 meal tags.** Meal tags correlate alongside payload items, distinguished by `via: "tag"` vs `"item"`.

**T17.5 `--since`.** Validated by the shared rule (T14.10, `INVALID_ARGS` on prose); both sides of a pair must be inside the window — a meal before the cutoff with a next-day symptom after it does not count (mutation-verified on the meal-side clause).

**T17.6 soft-deleted.** Deleted meals and symptoms contribute no pairs (mutation-verified).

**T17.7 `--human`.** Markdown, not JSON, carrying the not-causation label, the window names, and the counted pairs.

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
**T-W.6 body-update diff (origin-scoped).** Node body has `[[A]]`; also a `direct` `references` edge to B. Update body to `[[B]]` (drop `[[A]]`) → wikilink edge to A removed, wikilink edge to B **not duplicated** (the existing direct edge to B survives untouched with origin `direct`); a wikilink to a genuinely new target adds an edge. Only `origin='wikilink'` edges are ever added/removed by resolution (SPEC §5.1).
**T-W.7 unresolved links are not persisted.** Body has `[[Future Thing]]` (unknown) → reported in `unresolved`; creating a node titled "Future Thing" afterwards does **not** materialize an edge (stated v1 limitation, SPEC §5.1).
**T-W.8 no self-edges.** A body wikilinking its own node (by title or id, on add or body update) creates no edge and is not `unresolved` — a node naming itself is not a relationship.

---

## 6. Ranking & suggest constraints (Phase 2 — now shipped as Items 11–13)

Ordering-property assertions only; suggestion tests assert candidate presence/absence and that rejected pairs are never re-proposed — never score values. Scores, weights, decay curves, and the similarity threshold are tunables, not contracts.
