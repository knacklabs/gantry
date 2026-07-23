---
name: proactive-surfacing-v1
description: "proactive-surfacing v1 (de-risked, opt-in, value-floored, durable-fix ladder) shipped on PR #182; cold outreach = v1.5, tacit interview = v2"
metadata: 
  node_type: memory
  type: project
  originSessionId: c437dd15-347f-4840-8340-6a7d28e338a3
---

Proactive-surfacing v1 was built + reviewed + shipped 2026-06-25/26 on branch
`feature/proactive-surfacing` → **PR #182** on `cawstudios/Agent.Gantry` (origin is
the fork `vrknetha/myclaw`; an `upstream` remote was added for fork-sync). CLEAN/MERGEABLE.

**What it is:** makes the agent proactively surface automation suggestions ON-TURN
(piggyback, NOT a cold cron), opt-in and trust-safe. It hardens + gates the existing
on-turn pattern-candidate path (`loadPatternsContext`) rather than building new outbound.

**Design = the "de-risked outbound" the /autoplan premise gate produced** (both CEO
voices challenged the original cold-cron design 6/6 → reframed). 8 pieces, each a commit:
unified subject keying + blocking live-Postgres seam proof (closed an empty-`userId` DM
cross-conversation leak); per-conversation opt-in store keyed on the normalized subject
tuple `{appId,agentId,subjectType,subjectId}` (explicit SQL migration 0089 + journal);
recurrence value floor (occurrences>=4 AND >=2 distinct days — `pattern-candidate-policy.ts`,
NO friction column, `// ponytail` deferred); atomic surfacing claim (reused `repo.transition()`
UPDATE...WHERE status='detected' RETURNING); fail-closed opt-in+locked gate at the runner
callsite (`group-agent-runner.ts`, before accessPreset resolves); host-owned suggestion copy
+ injection/secret floor; durable-fix action-kind ladder (`pattern-candidate-action-kind.ts`:
scheduler_job/durable_capability/skill/memory_update → existing reviewed tools, never
auto-executes); host-mediated consent tool (`proactive_surfacing_consent` handler — rejects a
forged "yes" without a real latest-turn user reply) + kill-switch metrics (hashed subjectId +
signature, never outcomeLabel/shortAsk/jid).

**Eng review (both voices) ship-blockers, all folded in:** normalized-subject key (not raw
jid); the real divergent seam was the two subjectType derivations (now ONE shared fn in
`shared/pattern-candidate-subject.ts`); atomic claim; host-mediated consent; host-owned copy;
explicit migration+journal.

**Gotchas hit:** value floor (occ>=4) regressed the seam test which seeded only 3 turns →
bumped the test seed (a per-piece gate won't catch cross-piece regressions, only the full
suite does). The PR also bundled the user's local "async MCP task flow" which DUPLICATED
upstream PR #181 (5ca522f7b) — resolved the merge by keeping upstream's + the proactive
consent wiring, dropping the duplicate.

**Deferred:** v1.5 = cold/offline outreach (agent speaks when user away; the turn-independent
`sendMessage` at channel-wiring.ts:302 already exists, gated behind v1 metrics). v2 =
tacit-knowledge gap detector + Mom-Test interview.

**Pre-existing, NOT from this work:** `check:architecture` flags `group-processing.ts`
849/828 lines — already over on `main` at the branch base.

Related: [[legibility-plan-autoplan-review]], [[proactive-skill-loop-branch]] (the underlying
pattern-candidate loop), [[runtime-prompt-guidance-source]].
