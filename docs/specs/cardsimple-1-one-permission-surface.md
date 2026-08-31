---
slug: cardsimple-1-one-permission-surface
title: CARDSIMPLE-1 — One permission surface, family-wide grants
status: confirmed
saved: 2026-08-31T18:30:03+00:00
---

# CARDSIMPLE-1 — One permission surface, family-wide grants

Story: CARDSIMPLE-1
Inputs: owner rulings 2026-08-31 (chat): one permission card with Allow/Deny as the only surface; Allow always settles the future ("if agent ask curl with a website, it may call for others too"); minimal messages; late tap = save + receipt, never auto-rerun. Validated by four Codex sol@xhigh read-only passes 2026-08-31 (plans/exploration/cardsimple-1-v1..v4) against the live codebase; their blockers are folded in below. Live evidence: job `card-check-2` (thread sl:C0BDA10SWBG/1788170765.342719) — duplicate surfaces per blocker; ONE Allow tap created THREE forever-pending `job_permission_handoff` triggers (one per dead priorRunId; fanout at job-permission-provider-actions.ts:166 → reconciler:498, undispatchable because enqueue never re-activates the paused job); grants today are exact-argv (`curl <url-A>` grants nothing for `<url-B>`).

## Why

Every extra message and every repeat ask erodes trust in the cards. One surface with two verbs — Allow and Deny — where Allow settles the question for the future, and a tap that arrives after its run died gets a one-line receipt instead of silence, dead buttons, or a second card.

## Behaviour

### One canonical card

- The job permission card (`job_permission_card`, the existing multi-need aggregate) becomes the ONLY surface for a blocked need. The setup-pause permission prompt (a second, parallel card implementation today — setup-pause-permission-prompt.ts) is folded into it; the standalone "Setup needed" prose SEND is removed. `formatSchedulerSetupStory` is retained as the canonical card-body/row projection (it already feeds `decisionReason`), not as a separate message.
- One card for ALL need classes (grill R1b): every `JobSetupActionShape` — tool, credential, capability-install, channel-setup, instruction-only, compound — gets a defined row/action mapping on the canonical card. Blockers with no grantable action render as instruction rows on the same card, never as prose messages.
- Card creation is setup-fingerprint-backed and independent of a live run lease (today attachment requires a live runId/lease — job-permission-durability-wiring.ts:215), covering creation-time, preflight, final-setup, denial/timeout and partial-recovery pauses.
- Card delivery/revision becomes the sole owner of `notified_fingerprint` (today the prose send marks it — execution-readiness.ts:232); a durable "sole card established/pending" signal suppresses the setup-terminal send so a second actionable surface can never leak (execution-notifications.ts:396 path). Delivery exhaustion stays retryable without minting a new surface.
- The `transient_permission` completed-with-limits terminal receipt is explicitly preserved (already exempt via suppressNotification — execution-finalization.ts:309).
- Deny keeps decision 0144 intact: a denied row stays on the living card with one-tap Reconsider; no receipt, collapse or retirement may clear that action.
- CARDFIX-1 cut is explicit: the pause-story affordance path (`setupStoryActionAffordances` + the four provider codecs for prose-card buttons) is deleted with the prose send; the retry-and-ask capability survives as the canonical card's compound-row action (fingerprint-bound `scheduler_retry_ask` executor and the #462 interactive host-provenance lane are retained). The Pause job button is DROPPED (grill R2a, 2026-08-31): a blocked job is already paused, Deny leaves it paused; pausing an active job stays a chat/CLI affair. Its neutral kind, callback variants and four provider codecs are deleted with the prose card.
- Card route ownership (grill R2b, 2026-08-31): the approver route alone owns the card; other notification routes intentionally see nothing until the terminal outcome. No per-route projections.

### Grants: Allow settles the future

- Allow on a simple external command records a durable FAMILY rule: canonical shape `RunCommand(<literal argv0> *)` (existing matcher grammar — trailing `*` over remaining argv; NOT new parser syntax). The durable-access validator's leading-wildcard-breadth rejection (durable-access-policy.ts:219) is amended to admit exactly this literal-argv0 family shape. Family stays `grant: rule` (JOBPERM-2's rule|once — breadth widening, not a third mode).
- ONE shared family-rule synthesizer serves all three lanes that mint command rules today (host permission-suggestion-synthesis, SDK runner permission-suggestions, autonomous-bash-recovery-rule) — no lane keeps exact-argv synthesis.
- Scope: families apply to simple external commands eligible for durable RunCommand access; existing exclusions stand (meta-executors, stateful/interpreter shapes, destructive redirects, remote-content) — those stay per-ask or reformulation.
- Risk gating with a REAL enforcement point (corrects the draft): a family-rule match is provisional — the deterministic destructive/privileged/egress rails evaluate the EXACT command before the match is honored; a rail hit downgrades to ask, and the resulting Allow is once-only. Autonomous runs remain classifier-free (0121); YOLO denylist is not the gate. This ordering change (rails before reviewed-rule return, today coordinator returns rule matches first — permission-decision-coordinator.ts:84) is part of this story and gets a decision record.
- Family grants update agent-owned permission authority only — never job definitions or `access_requirements` (0106).
- Compounds, corrected to 0134/0144 exactly: piped commands NEVER get an Allow button — their row is reformulation-only (as today). Safe non-piped compounds are authorized by per-leaf durable rules (per-leaf family rules apply), never a compound-wide grant. `once` is reserved for executable requests with zero persistent suggestions. The compound-row action for a paused job is the fingerprint-bound retry-and-ask (one fresh run in ask mode; nothing durable), riding the canonical card.

### Late tap

- Tap-time liveness is explicit: the callback checks the run lease and returns a typed `live | late` outcome. Live ⇒ today's flow. Late ⇒ record the decision exactly as if live (rule breadth included), reply with ONE receipt line ("Run's over — saved for future runs") plus a Run now button. Never auto-rerun.
- Allow creates ZERO rerun barriers and ZERO job triggers (kills the per-dead-priorRunId fanout). Only a Run now tap creates exactly one job-scoped trigger — after making the job runnable — and a failed dispatch settles that trigger instead of leaving it pending. Run now rides the #462 interactive host lane.

## Acceptance criteria

- AC1: a blocked scheduled-job need yields exactly ONE actionable surface — the canonical job permission card — on all four providers, for every JobSetupActionShape and every pause cause (with or without a live run); no "Setup needed" prose message is sent; `notified_fingerprint` is owned by card delivery; the reconciler does not loop on unnotified pauses; no second actionable terminal card can be sent while the sole card is established/pending.
- AC2: Allow on a simple command records the canonical family rule via the ONE shared synthesizer such that a later run invoking the same argv0 with different args proceeds without asking; a rail-hit (destructive/privileged/egress) inside an allowed family still asks and permits Allow-once only; piped commands present no Allow; safe non-piped compounds resolve per-leaf; pinned local_cli readiness matching is unchanged.
- AC3: a late tap (run lease gone) records the same durable decision, replies with a single receipt plus Run now, creates no barriers/triggers on Allow, at most one settled-on-failure trigger on Run now, and never auto-runs; a denied row keeps its live Reconsider (0144).
- AC4: existing unit and Postgres integration suites pass; tsc and check:architecture green.

## Not in scope

Remaining GRACE-1 findings (lost retry timer, waiting-job reminders, unregistered-channel courtesy reply, provider-unknown log), egress-gateway policy, YOLO policy, interactive-lane classifier behavior, and any change to 0134's piped-command invariant.
