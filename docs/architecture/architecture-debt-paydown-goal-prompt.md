# Architecture debt paydown — goal prompt

Status: SCOPED 2026-07-22 (first story through the symphony-forge harness).
Goal: `npm run check:architecture` exits 0 on main so the harness structural
gate (`FACTORY_STRUCTURAL_CMD`) is green for every subsequent story.

## Why now

`.envrc` pins the harness deterministic verify to
`npm run format:check && npm run check:architecture`. The checker fails on
baseline main across five sections, so every future `verify.py` run fails
until this lands. Line-budget violations are never waived
(`docs/review-instructions.md`); exceptions must stay time-bounded ratchets.

## Failing inventory (2026-07-22 baseline)

1. **File Size Budget** — split behavior-preserving:
   - `apps/core/src/adapters/llm/observability/genai-spans.ts` 1488/700 (worst)
   - `apps/core/src/adapters/llm/observability/sse-accumulator.ts` 760/700
   - `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts` 730/720
   - `apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts` 724/720
   - `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts` 715/700
2. **Active Doc References** — ~130 dangling doc→file references; fix moved
   paths in live docs, and for historical records (goal-prompts of shipped
   work, ponytail audits, codex-harness/self-improvement) either mark the doc
   historical in the checker's supported way or repair the reference — do NOT
   relax the rule globally.
3. **Layer Import Rules** — runtime/adapters importing config files beyond
   exception `maxViolations` caps (fleet-boot, control/server routes incl.
   `apps/core/src/control/server/routes/observer.ts` with NO exception). Fix the imports (narrow ports /
   move types) rather than raising caps; a raised cap needs a ratchet
   deadline.
4. **Provider Boundary** — `ANTHROPIC_` tokens in `haiku-turn.agent-e2e` and
   `memory-lifecycle.postgres.integration` tests outside the adapter
   boundary; move behind the boundary or record exact debt in cleanup plan
   `myclaw-architecture-gates-20260517-provider-boundary-sentinels`.
5. **Provider-Specific Paths** — `slack`/`telegram` literals in
   `apps/core/src/application/agents/prompt-profile-service.ts:332-351`; route through the
   channel-neutral seam or an approved adapter path.

## Constraints

- Pure refactor: no behavior changes. Decision 0003 applies (no shims), but
  this story should not break any public surface at all.
- Splits follow `docs/architecture/codebase-refactor-principles.md`; no
  wrapper-only files, no `utils` buckets.
- Architecture exceptions edited only as time-bounded ratchets with max
  counts; file line-budget violations are never waived.

## Acceptance criteria

- `npm run check:architecture` exits 0.
- `python3 .agents/scripts/verify.py` passes end to end (structural,
  typecheck, tests).
- `npm run typecheck` and `npm test` green; no test deleted to get there.
- No public API/contract change (contracts package diff is empty).
- Any remaining exception entry has an expiry/ratchet note.

## Verify commands

```bash
npm run check:architecture
npm run typecheck
npm test
python3 .agents/scripts/verify.py
```
