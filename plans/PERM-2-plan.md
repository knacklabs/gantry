# PERM-2 — Permission engine: decision coordinator remainder (classifier-led)

## Problem
PERM-1 shipped the deterministic rails, the coordinator precedence skeleton
(hard-deny → locked → fixed-image → reviewed-rule allow → rails → tail), ASK→human
routing, RunCommand telemetry, the trusted-root deny-floor, and a fail-closed
schema-enforced classifier. The permission system still prompts on **every**
identical call because the classifier runs on every tail and there is no decision
memory — so "ask once" never holds, and a redundant strict posture makes the model
re-do the rails' job and over-ask. This is the runtime friction blocking agent
work. Goal doc: `docs/architecture/permission-engine-redesign-goal-prompt.md`
(L1 remainder). Exploration: read-only pass 2026-07-23 (file:line below).

## Scope / Non-goals
- L1 remainder ONLY: classifier posture collapse + tightened instructions,
  versioned canonical effect key, decision-memory table (4 kinds), in-coordinator
  cache stage, jobs `paused`/resume, removal of SDK `allowedTools`/
  `alwaysAllowedTools` bypasses, learned-root ask-once.
- Non-goals: L2 sandbox relaxation (separate); any new provider; changing the
  PERM-1 precedence order; caching `allow_once`.

## Acceptance Criteria (roadmap PERM-2 + goal-prompt slice)
1. Single authority path — every lane reaches `coordinatePermissionDecision`
   exactly once; SDK `allowedTools`/`alwaysAllowedTools` no longer silently
   approve (test: an allowedTools-listed tool still crosses the coordinator).
2. Deterministic ask-floors re-run on every cache hit, never cached away — a
   cached `classifier_verdict=allow` whose effect now trips a rail returns ASK.
3. Classifier verdicts cached with schema-enforced shape; ask-once demonstrated
   live (2nd identical exact effect ⇒ no LLM call).
4. Parse-fail + interpreter-with-string leaves always ASK, never cached, never
   classifier.
5. `allow_once` NEVER written to memory (runnable repo-assert).
6. Precedence intact — hard-deny/locked/fixed-image outrank any cached/classifier
   allow (locked agent + cached allow ⇒ denied).
7. Jobs pause not fail — non-standing ASK on a fenced job ⇒ run `paused`, owner
   approval resumes the SAME fenced run, ask routes to `controlApprovers` not the
   delivery route; a delivery-routeless job still asks.
8. Learned-root ask-once — first op in a new root ⇒ ASK once ⇒ remembered;
   options `[this folder][once][deny]`.
9. Existing permission suites green; typecheck clean; autoreview clean per commit.

## Technical Approach — bounded tasks, disjoint write_scope

### Task A (LEAD) — classifier: one empowered posture + tightened instructions
Current instructions (`runtime/permission-classifier-prompt.ts:11-31`) are ~90%
aligned already (independent judge, action-not-requester, semantic-risk
allow-by-default, schema-enforced, fail-closed). Two deltas:
- Collapse the dual posture: drop `STRICT_SYSTEM_PROMPT` + the `posture` param
  (`permission-classifier.ts:79,338-341`; prompt.ts:33-39). `auto_strict` keeps
  its strict *behavior* from the deterministic gate already at
  `classifier.ts:315-322` (unchanged) — the rails, not a second prompt, are the
  floor.
- One explicit line that routine shell/OS/read/build/test/in-workspace-edit is
  the default ALLOW; ASK only on concrete risk. (Precise rewrite in the plan
  appendix; deliberately close to shipped text.)
- write_scope: `runtime/permission-classifier-prompt.ts`,
  `runtime/permission-classifier.ts`, `application/permissions/permission-classifier.ts`.

### Task B — versioned canonical effect key
New `domain/permission-effect-key.ts`: `effect_hash = sha256(vN | railVersion |
appId | agentFolder | canonicalToolName | canonicalEffectJSON)` with
length-prefixed/`\0`-delimited fields (so `a|b ≠ ab`); the two version integers
are INSIDE the hash so a rails/schema bump invalidates all rows. **Do NOT hash the
bash-parser output** (it strips quotes / flattens `&&`); hash the canonical effect
(cwd+repo identity, symlink-resolved targets, dest host, executable-under-real-PATH,
risk flags). Skip the cache entirely when exact input is unavailable
(sanitized/redacted/truncated ⇒ `effectHash` undefined ⇒ no read, no write).
- write_scope: new `domain/permission-effect-key.ts`, `runtime/ipc-parsing.ts`,
  `domain/types.ts` (new `PermissionApprovalRequest` fields). **`high` reasoning.**

### Task C — decision-memory table + repo (4 kinds)
Migration `0107_permission_decision_memory.sql` (+ meta snapshot + journal;
mirrors `0098_permission_promotion_counters`). Columns: id, app_id, agent_folder,
`kind` discriminator, lookup_identity, effect_hash, decision, reason,
canonical_root, principal, effect_schema_version, rail_version, provenance,
created_at, expires_at, revoked_at. Partial-unique active index
`(app_id, agent_folder, kind, lookup_identity) WHERE revoked_at IS NULL`.
Kinds: `classifier_verdict` (only effect-hash-keyed reuse), `remembered_deny`,
`trusted_root`, `standing_grant`. Repo `put` REJECTS a human `allow_once`
(runnable assertion). Port + repo wired in `domain-repositories.postgres.ts`.
- write_scope: new migration + meta, `schema/schema.ts`, new
  `repositories/permission-decision-memory-repository.postgres.ts`, new
  `domain/ports/permission-decision-memory.ts`, `repositories/domain-repositories.postgres.ts`.

### Task D — coordinator cache stage (rails re-run every hit; classifier cache-miss-only)
In `permission-decision-coordinator.ts`, after the rail result (already computed
first): deny/hard-allow floor returns unchanged; else read
`decisionMemory.getClassifierVerdict({appId,agentFolder,effectHash})` — a cached
`allow` is reused ONLY if no rail now returns ask (rails re-ran first, so a stale
allow is overridden by a fresh rail ask/deny); on miss → `tail()`, where the
classifier runs (the ONLY call site) and writes the verdict back (never on human
allow_once). New coordinator inputs `effectHash?`, `decisionMemory?` threaded from
`resolvePermissionIpcDecision`.
- write_scope: `runtime/permission-decision-coordinator.ts`,
  `runtime/ipc-permission-classifier-decision.ts`.

### Task E — jobs `paused` status + resume-same-run
Add `'paused'` to `JobRunStatus` (`domain/job-types.ts:156`), propagate to
`jobs/run-status-event.ts`, `application/jobs/job-management-types.ts`. A
non-standing ASK on a fenced job ⇒ mark run `paused` (not `failed`), persist the
pause + pending decision, resume the SAME fenced run via the existing run lease
(`runLeaseToken`/`runLeaseFencingVersion`). Ask surfaces in durable job status AND
to `controlApprovers` — NOT the delivery route. Jobs inherit standing grants.
- write_scope: `domain/job-types.ts`, `jobs/execution-finalization.ts`,
  `jobs/run-status-event.ts`, the job runner/resume path,
  `application/jobs/job-management-types.ts`.

### Task F — remove SDK allowedTools/alwaysAllowedTools bypass
Remove `allowedTools`/`alwaysAllowedTools`-sourced auto-allow from
`agent-capabilities.ts` (460-478, 253, 432-433) and the rule folding in
`runner/tool-permission-gate.ts` (72-90, 337/485-489) so the only standing-allow
authority is the coordinator's reviewed selected-rule + decision-memory. (On this
branch `query-loop.ts` does not project `allowedTools` to the provider — bypass is
host-side only, so scope is contained.) Prove coordinator-once per lane.
- write_scope: `adapters/llm/anthropic-claude-agent/agent-capabilities.ts`,
  `.../runner/tool-permission-gate.ts`, `.../runner/query-loop.ts`.
- Independent of B/C/D — can start in parallel.

### Task G — learned-root ask-once `[this folder][once][deny]`
- write_scope: `shared/permission-trusted-paths.ts` + coordinator wiring (declare
  after D).

Order: **A → B → C → D → (E ∥ F ∥ G)**; F independent, may start immediately.

## Decisions
- Collapse to ONE classifier posture (drop STRICT): the rails own the ask-floor,
  so a second conservative prompt is redundant and causes over-asking. (Simpler
  shape — fewer moving parts.)
- Cache key = EXACT versioned effect hash (not generalized): collision-safe; the
  goal-prompt's grilled choice.
- `allow_once` never cached; owner authority v1 = `controlApprovers`.
- Recommend recording a decision (`docs/decisions/`) fixing the classifier
  independent-judge direction (currently only in user memory) before/with build.

## Surface Impact
| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | ask-once via cache; jobs pause instead of fail; fewer prompts |
| API | Unchanged | control response shapes unchanged |
| Data/schema | Changed | new `permission_decision_memory` table (migration 0107) |
| CLI/ops | Unchanged | — |
| Classifier prompt | Changed | posture collapse + one instruction line |
| Tests | Changed | cache/effect-key/memory/jobs-pause/bypass suites |

## Risks
- Effect-key collision → wrong reuse (security). Pin: delimited canonical fields +
  `demo()` self-check (`a|b ≠ ab`, quoting/cwd/dest change the hash).
- Stale cached allow surviving a rails tightening (security). Pin: rails re-run
  before cache read; test flips a rail to ASK and asserts override; version ints in
  the hash invalidate on bump.
- Sanitized/truncated input silently cached (security). Pin: no hash ⇒ no
  read/write; test truncated command ⇒ ASK + no row.
- Classifier over-asking after posture collapse (the whole point). Pin: benign OS
  command ⇒ ALLOW under auto AND auto_strict; credential read ⇒ ASK under both.
- Job pause deadlock / double-run. Pin: resume reuses the same run_id/lease;
  finalization no longer forces `failed` on pause.
- Ask leaking to a group delivery route (privacy). Pin: pause-ask targets
  `controlApprovers`, never the delivery targetJid when they differ.

## Verify Plan
```bash
npm run typecheck
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/{runtime,domain,application/permissions}
# postgres lanes for the decision-memory repo + coordinator chain:
GANTRY_TEST_DATABASE_URL=... npm run test:integration:postgres
python3 .agents/scripts/verify.py
```
