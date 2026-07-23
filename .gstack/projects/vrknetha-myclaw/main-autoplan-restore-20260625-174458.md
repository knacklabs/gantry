# /autoplan Restore Point
Captured: 2026-06-25 17:44 | Branch: main | Commit: d456f0d34

## Re-run Instructions
1. Copy "Original Plan State" below back to your plan file
2. Invoke /autoplan

## Original Plan State
# Proactive outreach v1 — opt-in, agent-initiated "make this a skill?" nudges

> **Note:** The earlier locked/public-mode prompt-hygiene plan (make the runner
> system prompt accessPreset-aware) is a **separate, ready, deferred** change for
> PR #169. This document replaces it for this session per the decision to design
> the outreach feature now. Locked-mode work is fully captured in the
> conversation and can be re-emitted on demand.

## Context

Goal: make the agent feel *alive and proactive* — it should reach out, surface
useful automations, and (later) pull threads to mine tacit knowledge. The user's
north star: "people have knowledge in their brains and without asking the right
questions even they don't know what they want." The hard constraint, in the
user's words: "do not irritate the users."

Today the runtime is **purely reactive**: a background "dreaming" pass already
detects repeated work (`pattern-candidate-detection.ts`, same intent ≥3× in
30 days) and the pattern-candidate loop already has battle-tested anti-spam
cadence (one-per-turn, 14-day snooze on "not now", 24h re-ask gate,
dismissed-forever, 0.7 confidence gate) — but it only ever **injects** its
suggestions into the user's *next* turn (`loadPatternsContext`). Nothing is ever
pushed; the agent never speaks first.

Two decisions scope v1 tightly:
- **Phase by source — repeated-work first.** v1 proactively surfaces the pattern
  candidates the system *already* detects ("we've done X a few times — want me to
  make it a reusable skill?"), reusing the entire cadence-safe pipeline. The
  richer tacit-knowledge interview (a new knowledge-gap detector + Mom-Test-style
  multi-question flow) is **v2**, layered on once the outbound path is trusted.
- **Opt-in only.** The agent sends **no** cold proactive message until the user
  explicitly enables it. This collapses the dangerous "unsolicited first contact"
  guardrails down to a single consent gate, and is the main reason v1 is safe.

The cold-send primitive already exists and is turn-independent
(`channel-wiring.ts:302 sendMessage(jid, text, options)` — no lease/turn guard,
durable delivery). The only genuinely new build is: the **consent gate**, a light
**selection/emit pass**, and the **post-opt-in cadence guardrails**.

## Decisions locked in

| Decision | Choice |
|---|---|
| PR | Separate PR (not bundled with locked-mode hygiene) |
| v1 source | Existing **pattern candidates** (repeated work); tacit-knowledge interview = v2 |
| Consent | **Opt-in only** — no cold message before explicit enable |
| Cold-open text | **Templated** from the candidate (reuse `pattern-candidate-block` phrasing); the rich reply is a normal agent turn |
| Locked/public agents | **Excluded** — no proactive outreach (skill machinery is banned for them; ties to the locked-mode PR) |

## Architecture (4 pieces, mostly reuse)

### 1. Consent gate (new, the safety floor)
A per-conversation opt-in flag — consent is per-conversation (one group opting in
must not enable outreach for another group the same agent serves), so it does
**not** belong in admin `settings.yaml` (`agents.[folder]`). Store it lightweight,
like pattern candidates:
- New small table (or columns) keyed by `(appId, agentId, conversationJid)`:
  `proactiveOutreachEnabled boolean`, `enabledAt`, `lastProactiveOutreachAt`,
  `optedOutAt`. Mirror the existing pattern-candidate repository style under
  `apps/core/src/adapters/storage/postgres/`.
- Default `false`. The whole selection/emit pass is dormant until `true`.

**How opt-in is obtained (in-conversation, never cold):** when the agent surfaces
a pattern candidate in a *live* turn and the user engages positively, it offers
once: *"Want me to keep an eye out and flag automations like this between our
chats?"* → yes flips the flag. (A manual settings toggle is a secondary path.)
This is consistent with "opt-in only" because the ask happens inside a
conversation the user started, not as a cold push. Reuses the existing
`pattern_candidate_decision` 3-outcome UX.

### 2. Selection/emit pass (new, light; mirrors the dreaming registration)
A new system job registered **per conversation route** exactly where dreaming is
(`system-jobs.ts registerSystemJobs(deps)`), on its own conservative cron
(separate from the nightly heavy dreaming pass). For each route it:
1. Skips unless `proactiveOutreachEnabled` and `accessPreset !== 'locked'`.
2. Applies the **post-opt-in guardrails** (new `proactive-outreach-policy.ts`
   mirroring `pattern-candidate-policy.ts`): frequency cap (recommend **≤1 / 7
   days per conversation** via `lastProactiveOutreachAt`); **idle-only** (skip if
   the conversation had recent activity — use the existing route/group
   last-activity signal — so we never interrupt a live thread); **quiet hours**
   (recommend a daytime window in the workspace timezone; configurable constant).
3. Selects the top eligible pattern candidate via the existing repository
   eligibility query (reuses `detected`/`suggested` status + 24h gate + 14-day
   snooze + intensify-delta — no new cadence logic).
4. Emits a **templated** outbound question via `deps.sendMessage(jid, text)`
   (reuse `pattern-candidate-block` phrasing, outcome-first, not tool-named),
   marks the candidate `suggested`, stamps `lastProactiveOutreachAt`.

### 3. Reply handling (pure reuse)
The user's reply arrives as a **normal inbound turn**. The existing
`pattern-candidate-block.ts` guidance already tells the agent: agree →
`request_skill_proposal(patternCandidateId)`; "not now" →
`pattern_candidate_decision(not_now)` (14-day snooze); "dismiss" → dismissed.
**One addition:** recognize "stop being proactive / don't ping me" → flip
`proactiveOutreachEnabled` off (`optedOutAt`). No new proposal/skill plumbing —
`request_skill_proposal` → reviewed install already exists.

### 4. Behavior/prompt (light for v1)
Minimal: ensure the live reply turn handles the proactive thread well. The deeper
curiosity/Mom-Test anchoring guidance (ask for a concrete recent example, anchor
vague "we usually…" answers) is **v2** with the interview flow. For v1, the
templated opener + existing pattern-candidate guidance suffice; do **not** bloat
the system prompt now.

## Guardrails summary (the "don't irritate" contract)

| Guardrail | v1 mechanism |
|---|---|
| No cold contact | Hard opt-in gate (`proactiveOutreachEnabled`, default false) |
| Frequency cap | `lastProactiveOutreachAt` + policy const (≤1 / 7 days / conversation) |
| Never interrupt | Idle-only gate (skip on recent activity) |
| Quiet hours | Daytime window in workspace tz (policy const) |
| Per-topic re-ask | Reuse pattern cadence: 24h gate, 14-day snooze, dismissed-forever |
| Global stop | "stop" reply or toggle → `optedOutAt`, gate flips off |
| Public agents | Excluded via `accessPreset === 'locked'` |

## Critical files

- `apps/core/src/jobs/system-jobs.ts` — register the new per-route selection job alongside dreaming (`registerSystemJobs`).
- `apps/core/src/jobs/types.ts` (`SchedulerDependencies`) — already exposes `sendMessage` + `conversationRoutes`; confirm, no new dep expected.
- New `apps/core/src/shared/proactive-outreach-policy.ts` — cap / quiet-hours / idle constants (mirror `pattern-candidate-policy.ts`). **If reachable from the runner, add to `test/unit/runner/ipc-mcp-stdio.test.ts` copy list** (repo memory gotcha).
- New per-conversation opt-in store under `apps/core/src/adapters/storage/postgres/` (+ schema migration) mirroring the pattern-candidate repository.
- Reuse: `pattern-candidate-block.ts` (phrasing + decision flow), `pattern-candidate-repository.postgres.ts` (eligibility query), `channel-wiring.ts:302` (`sendMessage`), `request_skill_proposal` handler (`ipc-skill-install-handlers.ts`).
- Opt-in/opt-out recognition: extend the inbound handling that already routes `pattern_candidate_decision`.

## Phasing

- **v1 (this plan):** opt-in proactive surfacing of existing pattern candidates over the cold-outbound path + the consent gate and post-opt-in guardrails.
- **v2 (future):** tacit-knowledge gap detector (memory-review contradictions / low-confidence / thin-coverage signals) + Mom-Test multi-question interview + the curiosity prompt-strengthening; reuses v1's outbound + guardrails wholesale.

## Verification

1. Typecheck: `cd apps/core && npx tsc --noEmit` → 0.
2. New unit tests:
   - **Selection eligibility** — opted-out / locked / over-cap / recently-active / outside-quiet-hours conversations are all skipped; an opted-in idle in-window conversation with an eligible candidate is selected exactly once.
   - **Emit** — produces a templated outcome-first message via a mocked `sendMessage`, marks the candidate `suggested`, stamps `lastProactiveOutreachAt`; second run within the cap window emits nothing.
   - **Reply flow** — "yes" → `request_skill_proposal(patternCandidateId)`; "not now" → 14-day snooze; "stop" → `optedOutAt` set and gate flips off.
   - **Opt-in acquisition** — positive engagement on a live pattern surfacing flips `proactiveOutreachEnabled`.
3. Migration test for the new table/columns; reuse pattern-candidate repo test style.
4. `npx vitest run test/unit/jobs/ test/unit/shared/ test/unit/runtime/` → no regressions.
5. Manual: enable on a test conversation, force an eligible candidate, confirm one well-phrased proactive message arrives (idle, daytime), a reply drives the skill proposal, and "stop" silences it permanently.
