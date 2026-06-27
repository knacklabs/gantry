# Memory & Continuity Fixes Plan

> **Audience:** the executing agent picking this up cold.
> **Companion to:** `runtime-refactor-plan.md` (this is the §99-C / Phase 5 detail). Read that first if you have not.
> **Author context:** drafted by main_agent after validating the recent memory/dreaming refactor against live behaviour. Infrastructure landed; practical recall is still broken because session subject is not threaded into the recall path. This plan closes that gap and the surrounding gaps that make continuity invisible to the agent.

> **Status note, 2026-05-22:** `continuity_summary` has shipped as a
> baseline Gantry MCP tool with a handler. The broader `memory_status`
> upgrade, self-bootstrap quality checks, and checklist items below remain
> implementation work until separately verified.

---

## 0. How to use this document

1. Read it top-to-bottom before touching code.
2. Verify every code anchor in §6 against the current tree before relying on it. Anchors are at commit `d18ba5f08a6496c462d27edf36773cb8a88cc4fe`; if drift is >20%, re-plan.
3. Phases are ordered by leverage. Do not skip ahead — Phase 1 unblocks the rest.
4. Keep PRs small. One concept per PR. Reference this plan and the relevant issue.
5. Honour the parent plan's non-negotiables: deletion budget, no silent success, no new tool without a handler, three-line errors, preemptive timeouts, no compat mode.

---

## 1. Mission

Make durable memory and continuity visible and useful to a running agent, not just a write-only background job.

## 2. Thesis

Three statements. Conflict with any of them is a wrong decision.

1. **Subject is resolved from session context, never defaulted to a constant.** A recall call that does not know whose memory it's reading is a bug, not a fallback.
2. **Dreaming must promote on its own for low-risk factual candidates.** Human review is reserved for preference-style memory. A pipeline that requires a human to be useful is not a pipeline.
3. **Continuity is an injected block, not a tool the agent has to remember to call.** If the agent must opt in to its own memory, the system has failed.

## 3. Non-negotiables

1. **No silent zero-result.** A recall that returns 0 must say which subject was searched and why nothing matched. "Empty" is a real signal only when the subject is correct.
2. **One subject resolver.** Session, recall, hydration, and dreaming all read subject from the same function. Grep should show one definition.
3. **Auto-promotion is reversible.** Every auto-promoted memory carries a `promoted_by: 'dreaming'` marker and is demotable in one call.
4. **Continuity injection is observable.** `memory_status` reports the exact bytes injected at last session start, the subject used, and the candidate counts (staged / promoted / needs_review).
5. **No new tool without a handler** (parent plan §3.3). Applies to `continuity_summary` if it ships.

## 4. Target shape

```
Session start
  → resolveSessionSubject(session)        ← single source of truth
  → loadSessionAppMemoryItems(subject)
  → hydrateContinuityBlock(subject)       ← memories + open commitments + recent decisions
  → inject into system prompt

Dreaming cron
  → stage candidates
  → guardrails.validate(candidate)
      → low-risk factual + grounded → auto-promote
      → preference / contradiction  → needs_review
  → emit dream_run event with counts

Agent recall
  → memory_search(query)        ← subject from session, not constant
  → memory_status               ← reports last dream, candidates, last injection
  → continuity_summary          ← runs, open issues, paused jobs, decisions
```

## 5. Phases

Each phase has **goal**, **scope**, **exit criteria**, **deletion target**.

### Phase 1 — Subject threading (the unblocker)

**Goal:** every memory read knows whose memory it is reading.

**Scope:**
- New `resolveSessionSubject(session) → { agentId, scope, workspaceFolder }` in `apps/core/src/memory/app-memory-subject-resolver.ts` (or co-located with boundaries). One definition.
- `app-memory-recall.ts:74` (`visibleSubjectFilters`) takes the resolved subject from the caller. If the caller does not have it, the call is a type error. No `DEFAULT_MEMORY_AGENT_ID` fallback in the recall path.
- `app-memory-boundaries.ts:54` (`DEFAULT_MEMORY_AGENT_ID = 'agent:personal'`) is deleted. Its only legitimate use was as a default; defaults are the bug.
- MCP `memory_search` / `memory_save` handlers read subject from the session context their handler runs in, not from caller args. Caller may *override* scope (with audit), not invent it.
- Empty-result responses include the subject used: `{ results: [], subject: { agentId: 'agent:main_agent', scope: 'group', workspaceFolder: '...' } }`.

**Exit criteria:**
- Repro from this session: `memory_search('fixture lead controller job')` from `main_agent` returns the durable facts saved during this and prior sessions, with provenance. (Requires Phase 2 to populate; for Phase 1 it is enough that the subject is correct and a manually-saved memory round-trips.)
- Grep for `DEFAULT_MEMORY_AGENT_ID` returns zero hits.
- Grep for `agent:personal` as a string literal in recall/save paths returns zero hits.
- Smoke test: save a memory under one subject, search with another — must return zero, with the correct subject reported back.

**Deletion target:** ≥150 lines net. Subject defaulting and its branches collapse into one resolver.

### Phase 2 — Auto-promotion for low-risk candidates

**Goal:** dreaming graduates from staging to a usable memory store without human review for safe candidates.

**Scope:**
- In `apps/core/src/memory/app-memory-dreaming.ts:458-544`, after `validatePromotableCandidate(candidate)` passes, route the candidate to `save()` directly when:
  - `kind ∈ { fact, decision, correction, constraint }` (not `preference`),
  - `confidence ≥ 0.7`,
  - guardrails report no contradiction with existing high-confidence memory,
  - evidence is grounded (the existing guardrail check at `app-memory-dreaming-candidate-guardrails.ts:255-312`).
- Tag the saved row with `promoted_by: 'dreaming'`, `promoted_at`, and the dream run id.
- `preference` candidates and any candidate failing the above still go to `needs_review`. No change to the human-review path.
- Add a `memory_demote` MCP tool that retracts a `promoted_by: 'dreaming'` memory (audit, not delete) for when auto-promotion gets it wrong. Per parent plan §3.3, ship the handler with the surface.

**Exit criteria:**
- A nightly dream run on a session with ≥1 qualifying candidate produces a non-empty `promoted` count in the dream-run event.
- `memory_search` from the agent's subject returns auto-promoted memories within one dream cycle of save.
- Auto-promoted memories are visible in `memory_status` with a `promoted_by` breakdown.
- `memory_demote` round-trips: promote → demote → no longer in search results, but row is retained with `demoted_at`.

**Deletion target:** ≥100 lines net (consolidation of the dryRun / needs_review branches).

### Phase 3 — Continuity injection (real, not minimal)

**Goal:** a fresh session for `main_agent` shows enough context that "what about the manual job we ran" is never a question.

**Scope:**
- `HydrateAgentContextService` (`apps/core/src/application/sessions/hydrate-agent-context-service.ts`) builds a structured block, not just top-N memories:
  - **Open commitments:** anything marked open in the commitments table, ordered by age.
  - **Recent decisions:** last N `kind: decision` memories.
  - **Active and paused jobs:** from the scheduler.
  - **Recently filed issues by this agent:** from a per-agent index (Phase 4 below adds the index; until then, omit gracefully).
  - **Top memories by relevance to current channel:** the existing top-8 path, kept.
- Block is rendered into the system prompt with stable section headers so the agent can scan it cheaply.
- Hydration emits one event with subject, block size in bytes, and section counts. Surfaced via `memory_status`.
- If hydration produces an empty block on a session that *should* have content (commitments table non-empty for this subject, or job count >0), log a `continuity_empty_unexpected` warning. This is the §99-C canary.

**Exit criteria:**
- Fresh `main_agent` session injects a non-empty continuity block whose size is reported by `memory_status`.
- Repro: pause `lead:fixture-controller`, start a new session — paused job appears in the injected block.
- `continuity_empty_unexpected` warning fires when the block is empty but state exists, and never fires when state is genuinely empty.

**Deletion target:** ≥80 lines net.

### Phase 4 — `continuity_summary` and `memory_status` upgrades

**Goal:** the agent can self-bootstrap when injection misses.

**Scope:**
- New MCP tool `continuity_summary` (handler shipped with surface):
  - Inputs: optional `since`, optional `limit`.
  - Outputs: last N runs (with terminal status and `error_summary`), agent-filed open issues, paused jobs, recent decisions, last dream-run summary.
- `memory_status` extended with: staged-candidate count, promoted-this-cycle count, needs-review count, last injected-block subject and byte size.
- Per-agent issue index built from `gh` audit log or a local table fed by issue-filing helpers — whichever is cheaper. If neither is cheap, omit and document the gap.

**Exit criteria:**
- `continuity_summary` returns a usable JSON block in <500ms on a populated environment.
- `memory_status` shows staged/promoted/needs_review counts that match the dream-run event log.
- An agent that explicitly lost continuity (e.g., post-compaction) can call `continuity_summary` once and recover the state needed to keep working.

**Deletion target:** ≥50 lines net.

### Phase 5 — Decommission

**Goal:** delete the parallel old paths.

**Scope:**
- Remove the recall-path subject defaults, any `agent:personal` constants, the dryRun-only dreaming branch, and any compat shims left from earlier phases.
- Final cloc against the Phase 1 baseline. Net delta must be ≥ –500 lines or this plan failed its own thesis.

**Exit criteria:**
- No `// TODO: remove after memory refactor` comments remain.
- No file imports both legacy memory helpers and the new resolver.
- `docs/architecture/canonical-domain-model.md` updated to reflect the single subject resolver.

## 6. Code anchors (verify in Phase 1)

| Concern | Path | Line | Phase |
| --- | --- | --- | --- |
| Recall subject filter (defaults to `agent:personal`) | `apps/core/src/memory/app-memory-recall.ts` | 74 | 1 |
| Subject normalization + default constant | `apps/core/src/memory/app-memory-boundaries.ts` | 54, 85–97, 106 | 1 |
| Session hydration entry | `apps/core/src/application/sessions/hydrate-agent-context-service.ts` | 70–99 | 3 |
| Session app-memory loader | `apps/core/src/memory/app-memory-session-hydration.ts` | 103–148 | 3 |
| System prompt memory block reader | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/system-prompt.ts` | 30–41 | 3 |
| Dreaming validate-and-route | `apps/core/src/memory/app-memory-dreaming.ts` | 458–544 | 2 |
| Dreaming guardrails | `apps/core/src/memory/app-memory-dreaming-candidate-guardrails.ts` | 255–312 | 2 |
| `memory_status` command | `apps/core/src/session/session-commands.ts` | 35 | 4 |
| `memory_status` formatter | `apps/core/src/session/session-command-format.ts` | 67–100 | 4 |

## 7. Cross-phase exit checklist

- [ ] `memory_search('fixture lead controller job')` from `main_agent` returns the durable facts after one dream cycle.
- [ ] Grep for `DEFAULT_MEMORY_AGENT_ID` and `agent:personal` literal in non-test runtime code returns zero.
- [ ] Auto-promoted memories are reachable by `memory_search` and tagged `promoted_by: 'dreaming'`.
- [ ] Fresh `main_agent` session injects a continuity block with the paused-job state.
- [x] `continuity_summary` ships with a handler.
- [ ] `memory_status` ships with staged/promoted/needs_review counts and a smoke test.
- [ ] `continuity_summary` has a populated-environment smoke test covering the self-bootstrap path.
- [ ] Net line count vs Phase 1 baseline: ≤ –500.

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Subject threading breaks existing tools that relied on the default | Phase 1 ships with a one-shot migration that re-keys any rows saved under `agent:personal` to the resolved subject by inspecting their `workspaceFolder`. No dual-read path. |
| Auto-promotion promotes a wrong fact | `promoted_by: 'dreaming'` marker + `memory_demote` tool + bias toward `kind: fact / decision` only; preference and contradiction routes stay in review. |
| Continuity block grows unbounded | Hard byte budget per section; oldest items drop first; `memory_status` reports if budget was hit. |
| `continuity_summary` becomes a hot path | Single SQL view, indexed; under 500ms on populated DB or it does not ship. |

## 9. Decision rules for the executing agent

1. **Delete the default before adding the resolver.** Removing `DEFAULT_MEMORY_AGENT_ID` first surfaces every implicit caller via type errors. That is the work.
2. **No new tool without a handler.** If `continuity_summary` is not ready, do not register it.
3. **No new abstraction without two callers.** The subject resolver has at least three (recall, save, hydration) — fine.
4. **If a §3 non-negotiable is in your way, stop and ask.** Especially around silent zero-results.

## 10. Definition of done

- All five phases' exit criteria met.
- Cross-phase checklist green.
- A repro session demonstrates: pause a job → start a fresh session → the agent surfaces the paused job in its first message without prompting.
- This plan is moved to the architecture history folder with a dated May 2026 filename and a closing note: actual deletion delta, what shipped, what was cut, what carried over.

## 11. Out of scope

- Multi-agent memory sharing across groups.
- Long-term archival / cold-storage tiering.
- Vector-store rewrites. The current Postgres backend is fine; the bug is upstream of retrieval.
- New memory kinds beyond the existing five.

---

**End of plan.** §99-C in the meta tracker is the verification target. When a fresh `main_agent` session injects continuity that includes the paused `lead:fixture-controller` job, this plan is done.
