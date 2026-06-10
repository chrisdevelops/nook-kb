# Nook Memory (`@nook/mem`)

Agent-agnostic memory layer: one SQLite database accessed through a `mem` CLI, shared by all agents.

This project uses Bun. Tests run with Vitest: `bun run test`. Typecheck: `bun run typecheck`.

The product spec is `docs/SPEC.md`; its contract-test companion is `docs/TDD.md`.

For the development workflow, see docs/agents/workflow.md.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues (`chrisdevelops/nook-kb`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root + `docs/adr/`. See `docs/agents/domain.md`.
