---
name: proactive-skill-loop-branch
description: "feature/proactive-skill-loop implements the pattern-candidate \"permanent employee\" feedback loop; key wiring + the one unverified seam"
metadata: 
  node_type: memory
  type: project
  originSessionId: b234eeb9-33e4-4a9f-8016-8f8b4b92f5ff
---

Branch `feature/proactive-skill-loop` implements the agent "permanent employee" loop from the design plan (`~/.claude/plans/analyse-the-current-agent-luminous-bird.md`): the daily memory/dreaming job detects repeated work and writes `pattern_candidate` rows; the runner surfaces eligible ones as a `[[PATTERNS_NOTICED]]` block next to durable memory; the agent proposes a skill in conversation; only an explicit "Create draft" user choice ever calls `request_skill_proposal` (the batch never proposes).

**Layout:** contracts `packages/contracts/src/memory/pattern-candidates.ts`; pure core in `apps/core/src/shared/pattern-candidate-{detection,policy,block}.ts`; schema `.../schema/pattern-candidates.ts` + migration `0087_pattern_candidate.sql`; port `domain/ports/pattern-candidates.ts`; repo `.../repositories/pattern-candidate-repository.postgres.ts` (reads + `transition` only); decision service `apps/core/src/memory/pattern-candidate-decision.ts`.

**Non-obvious constraints learned:**
- The memory layer (`apps/core/src/memory/*`) cannot import adapter repository classes and cannot add *new* external/adapter imports (capped in `.codex/architecture-exceptions.json`). The detection write therefore lives in the already-grandfathered `app-memory-item-queries.ts` (`detectAndUpsertPatternCandidates` + `buildDetectedRowValues`) via direct `db` + `pgSchema`, NOT through the repo. Candidate id is deterministic `pc:app:agent:subjectType:subjectId:signature` (idempotent, no crypto import needed).
- `prompt-profile-service.ts` (783) and `runtime-services.ts` (1062) are at their line caps; the patterns guidance lives in the formatter block intro (`pattern-candidate-block.ts`) instead of OPERATING_GUIDANCE to avoid exceeding caps. Runner repo getter is provided only in `runtime-app.ts` (the runtime path), not `app/index.ts`.
- Runtime-event tool name is read as `payload.tool` (see `execution-diagnostics.ts`).

**The one unverified seam (needs live Postgres + Phase 0 spike):** the runner queries `listEligible` with subject `{appId, agentId: group.folder, subjectType:'user', subjectId: memoryUserId}`, while detection writes with the dreaming `NormalizedMemorySubject` and `folder = dreamSubject.agentId`. Whether these match end-to-end (so candidates actually surface) is the thing the plan's go/no-go gate must confirm/tune. Detection currently feeds only the transcript-intent signal (evidence rows); the tool-sequence signal is supported by the pure heuristic but not yet fed from runtime events.

Pre-existing failure unrelated to this work: `apps/core/test/unit/jobs/async-command-sandbox-runner.test.ts` provider-boundary (ANTHROPIC_/CLAUDE_CODE_OAUTH_TOKEN) — fails on main. See [[preexisting-test-failures-credential-branch]].
