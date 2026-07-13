# Design Pass Needed: Interactive Auto-Permission Trust Anchor

**Status: SUPERSEDED (2026-07-13).** The trust-anchor approach was abandoned;
auto mode now judges the action, not the requester. See
`docs/architecture/auto-permission-action-based-goal-prompt.md` and the
"Auto-permission mode" section of `docs/architecture/capability-management.md`.
Historical record below.

**Original status: PAUSED for deliberate design (2026-07-13).** Group-interactive auto-allow
is NOT safe to ship as built. This doc records the problem, why the reactive
implementation did not converge, the requirements for a sound design, and where the
work-in-progress lives. Nothing here blocks merging the *rest* of the branch if the
interactive auto-allow path is disabled (see "Safe subset" below).

## What auto-permission needs (the hard part)

For an auto-mode allow_once on an **interactive** tool call, the host must establish,
without trusting any runner-authored IPC field, that:
1. **Who** triggered *this* run is a control approver for *this* conversation;
2. **What** they asked (the turn intent) is *this* turn's message;
3. Neither is **forgeable** or **replayable** by a compromised/prompt-injected runner.

The runner authors the entire permission IPC request. So `request.senderId`,
`request.turnIntentSummary`, and `request.runId` are all attacker-controllable and
cannot be the basis of the trust decision.

## Why the reactive build did not converge

Built stage-by-stage overnight; each per-stage local autoreview surfaced the next
trust hole. In order:
- **r12** — trusting `request.senderId` as approver proof → directly forgeable.
- **r13** — deriving trust by scanning recent history → not bound to the triggering
  turn; a non-approver rides a stale approver message in a group.
- **Stage C review** — `trustedRunId` threaded but audit still used `request.runId`.
- **Stage D review** — fresh live turns never bound their runId into the response key
  (only resumed runs did) → auto mode silently falls back to prompting.
- **Propagation fix review** — forwarding the runId as `GANTRY_JOB_RUN_ID` conflated
  the trust runId with the lease runId → fresh interactive requests rejected as a
  stale lease; and the origin wasn't checked against the request's conversation route
  → cross-conversation confused deputy (A's approver authorizes a request targeting B).
- **Convergence attempt review (the blocker)** — the whole anchor is unsound:
  `trustedRunId` is derived from `request.responseKeyId`, but **that key id is not
  bound into the current authenticated request, and response signing keys are never
  revoked after a run.** A runner in the same workspace/thread can sign a fresh
  permission request with its valid IPC token while supplying an **older**
  `responseKeyId` from a prior approver-triggered run; the lookup loads that old
  approver origin, route-matching passes (same thread), and the current request is
  auto-approved under **stale approver authority**. A replay the model must prevent.
  (Also P2: the lease-gated `runnerRunId` change dropped `run.runId` for inline runs
  passing `existingRunId` without a lease token, regressing inline durable-interaction
  association.)

The pattern — a new fundamental trust hole each round, the last one invalidating the
core anchor — is the signal to design deliberately rather than patch further.

## Requirements for a sound design

1. **Current, authenticated run identity.** The trust decision must key off the run
   id the host bound to the IPC auth material **for the request currently being
   authenticated** — not a runner-supplied `responseKeyId`/`runId` the runner can
   swap for an older one. Bind the run id into the same authenticated token/scope the
   host already verifies for the request (the filesystem/agent-folder auth), so the
   host recovers the run id from what it authenticated, not from a replaceable field.
2. **No replay.** Response signing keys (and any run→origin binding) must be **revoked
   at run end**, so a completed approver run's key/origin cannot authorize a later
   run. Freshness/liveness: only a currently-active run may confer authority.
3. **Conversation-scoped.** The origin's `targetJid`/`threadId`/`providerAccountId`
   must match the request's route (this check was added and is correct — keep it), but
   it is necessary, not sufficient; it does not stop same-thread stale-key replay.
4. **Uniform across spawn paths.** Live, scheduled, and inline/failover spawns must
   all bind identically, from a run id every path already owns, **without** projecting
   the trust run id into the runner env (keep it host-side; do not conflate with the
   job/lease runId or `GANTRY_JOB_RUN_ID`).
5. **Fail safe only.** Every gap → human prompt. The change may only remove trust.

## Candidate direction (to evaluate, not yet decided)

- Bind the run id into the **request-authenticating** material, not the
  response-signing key id. Investigate whether the permission IPC already carries a
  host-verifiable per-request/per-run token (beyond the filesystem agent folder) that
  the host authenticates; if so, recover the run id from *that*, and drop
  `responseKeyId` as a trust input entirely.
- Add **run-lifecycle revocation** of the run→origin binding (and response keys) at
  run terminal state, with an active-run check at permission time.
- Reconsider scope: **DM-only interactive auto-allow** is simpler (single approver,
  one thread) but does NOT by itself close same-thread stale-key replay, so it is not
  a shortcut around requirements 1–2.

## Current repository state

- **Committed on `feature/auto-permission-mode` (clean, HEAD `055674ea5`):** Tier-2,
  the auto-permission feature, all earlier fix rounds (incl. the r12 host-authoritative
  fix), and run-origin Stages A–C: the `run_permission_origin` table/repo (A), origin
  recorded at spawn (B), and the `responseKeyId → runId` binding + attribution (C).
  **A–C are inert** — the committed decision path does not yet consume the origin, so
  they change no behavior on their own.
- **The committed decision path still has the r13 issue** (Stage 7 host-authoritative
  message-store scan can pick a stale approver in a group). So the interactive
  auto-allow path is NOT sound as committed either.
- **Stashed (`git stash@{0}`):** run-origin Stage D (decision reads origin) + all the
  binding fixes. Recover with `git stash apply`. Do NOT commit as-is — it carries the
  responseKeyId replay P1 and the inline-runId P2.

## Safe subset (if we want to merge the rest before the design pass)

Disable interactive-sender auto-allow entirely: `resolvePermissionAuthority`'s
interactive path returns untrusted (→ human prompt, today's behavior), keeping only
the scheduled/unattended auto-allow (host-verifiable). That removes every open trust
issue and makes the branch merge-safe, with group-interactive auto-allow deferred to
the design implemented from this doc. (Chosen alternative to a daylight design pass;
recorded here for completeness.)
