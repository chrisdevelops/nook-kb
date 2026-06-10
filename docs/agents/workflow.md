# Development Workflow: The Verified Delegation Loop

The spine: define the context, define the tools, define the feedback loop, define the
guardrails, let agents work, preserve human understanding. The human owns spec, taste,
and understanding. Agents own execution inside verifiable loops.

## Per feature

1. UNDERSTAND (human in the loop)
   - Unfamiliar code in the blast radius: /zoom-out first.
   - No domain docs yet: /grill-me. Established docs: /grill-with-docs (updates
     CONTEXT.md and ADRs inline).
   - Real design uncertainty: /prototype before committing to an approach.

2. SPECIFY
   - /to-prd. Confirm the test seams with the user — seams define what "verified"
     means for this feature. Prefer the highest existing seam.

3. DECOMPOSE
   - /to-issues into tracer-bullet vertical slices, each demoable end-to-end.
   - Classify slices: AFK (well-specified, mechanically verifiable — fully delegable)
     vs HITL (security, auth, payments, data identity, public API shape, or anything
     requiring design judgment — human stays in the loop).
   - A slice without a defined verification path is not ready to publish.

4. EXECUTE
   - One slice at a time with /tdd: red, green, refactor. The failing test comes first.
   - Bugs and regressions: /diagnose, always ending in a regression test.
   - Context running long: /handoff to a fresh session.

5. REVIEW
   - Review changes against repo standards and against the PRD.
   - The human reads the diff. Working is not the bar; plausible code with wrong
     system design goes back to step 1 as a grilling topic, not a code tweak.

6. CONSOLIDATE
   - Merge through the pre-commit and CI gates.
   - CONTEXT.md and ADRs stay current — they are the project's compounding memory.
   - Every few days: /improve-codebase-architecture to counter entropy.
   - Anything merged that the human does not understand gets explained via /zoom-out
     before more work builds on it.

## Standing rules

- CLAUDE.md stays minimal; new conventions go in docs/ files, not CLAUDE.md.
- CONTEXT.md is a glossary only — no implementation details.
- ADRs only when a decision is hard to reverse, surprising without context, and the
  result of a real trade-off.
- Bugs found during work get filed to the issue tracker via /triage, not fixed
  opportunistically mid-slice.
- Destructive git operations are blocked by hooks; do not attempt to bypass them.
