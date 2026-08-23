# Design v9 (FROZEN FOR IMPLEMENTATION): Chat-parity permissions for scheduled jobs (JOBPERM-1)

Owner mandate (Ravi): a scheduled job must never lose accuracy because a tool
was blocked. The agent needs a tool → the user is asked in-channel → approves
once → permanent for the job → the run continues. No Allow-once (owner ruling:
a job recurs, so every approval is permanent). UX innovation (owner-directed):
approve the TOOLBOX, not tool-calls — one living card, never a stack.

v9 after seven adversarial Codex xhigh rounds (57 findings, all resolved).
Round 8 confirmed all owner rulings are honored; its residual edge specs are
folded below. The prose loop is CLOSED — remaining assurance moves to
implementation review (every Codex diff reviewed against this document as the
contract) and the mandated unit/adapter tests.
Owner directives folded: no Allow-once; approve-the-toolbox UX; SINGLE-CUT
IMPLEMENTATION (unify by deleting the parallel autonomous permission lane —
see Deletions). Owner-accepted physics limits are normative: checkpointed
continuation and in-session dynamic reprojection are OUT for v1 by owner
decision; reviewers judge against this contract, not an absolute reading of
the accuracy slogan.

## Principle (stated honestly)

**A scheduled run never dies silently because of permissions, and the user is
never surprised.** Every grantable permission miss becomes one visible,
durable question. Approval within the wait window resumes the run in place.
Approval for a tool the session cannot load persists immediately and is
available next run — the current run finishes honestly (its result names the
limitation) with a one-tap [Run again now]; nothing re-executes side effects
behind the user's back. An explicit Deny is terminal for that need and never
re-asked for the job until the user reopens it. Two narrow, owner-visible
physics limits (below) are the only places "approve once, forever" does not
apply.

## Owner-visible physics limits (the honest edges)

1. **Remote-content execution cannot be permanently pre-approved — as an
   EQUIVALENCE CLASS, not a token.** `curl URL | sh` and its staged twin
   `curl -o /tmp/x URL && sh /tmp/x` carry the same risk: identical command
   text, different remote bytes every run. The hard boundary covers pipes,
   destructive redirects, inline interpreters, AND download-then-execute
   flows — ACROSS CALLS AND RUNS, not just within one request: an
   interpreter/executable leaf whose target is a mutable or unreviewed file
   path is nondurable, period (so `curl -o /tmp/x URL` may be granted as a
   fetch, but `sh /tmp/x` can never become a permanent rule; reviewed
   capabilities that bind execution to a reviewed artifact/digest are the
   sanctioned path). These shapes get a typed, truthful
   reformulation result (restructure into grantable forms or a reviewed
   capability that binds execution to a reviewed artifact/digest). No card,
   no pin, no denial-memory. Everything else — commands, compounds,
   capabilities, MCP tools, browser — is one-tap permanent.
2. **A tool granted mid-run that the session cannot load is available next
   run, not this one.** Auto-rerunning to "fix" the current run would
   re-execute its side effects (double outreach messages, double sheet rows).
   Instead: the grant persists now, the run ends as **"Completed with
   limits"** (existing status) — visibly incomplete, never presented as a
   full completion — its result names the missing tool, and the completion
   card carries [Run again now] so the HUMAN decides whether re-running is
   safe for this job. NO automatic rerun exists anywhere in this design: the
   post-handoff pause card's single action is literally **[Approve & run
   again]**, so every rerun after partial work is human-initiated by
   construction. JOBPERM-2 (in-session dynamic projection) upgrades this to
   true in-place continuation later — out of v1 by owner decision.

## Evidence

(unchanged — compound cancel #434; 6 days of dead-ends in 2 weeks;
request_access itself denied; browser granted+prelaunched but unreachable
because the autonomous lane refuses to await the host's own yes-verdict;
"Allowed by…" strings delivered as denial reasons.)

## Root cause

The autonomous permission lane hard-returns "denied" without waiting
(`permission-callback.ts:265-276`, timeout 0).

## Core model: the durable NEED

All coordination keys off a durable **need**: `(jobId, canonical need
identity)` — for a single-rule shape, the canonical tool rule; for a
control-flow compound, ONE COMPOSITE need whose identity is the canonical
ORDERED rule-set of its leaves (one tool call = one question = one decision;
approval persists every leaf rule atomically; there is no partial denial of a
compound); for capability needs, the capability id. (Hard-boundary shapes
never create a need — they short-circuit to the typed reformulation
result.) The need row (reusing the
durable pending-interaction store) outlives card instances, run attempts, and
host restarts. Cards, waiter resumes, pause-card handoffs, and deny-memory all
reference the need — a click on ANY card instance, old or replacement,
resolves the same need exactly once (claim protocol, 0056), WITHIN ITS ASKING
EPOCH: every need carries an `asking_epoch` (incremented on Reconsider/reopen)
and every card action token carries the epoch it was rendered for; the CAS
includes the epoch, so a delayed callback from a previous epoch's card can
never decide a reopened question.

Need states:
`asking → approved_pending_apply → applied` | `denied_pending_delivery →
denied` | `handoff_pending → handed_off (pause card)` | `cancelled`.

One idempotent host reconciler drives every pending state:
- `approved_pending_apply → applied`: FIRST revalidate against CURRENT
  policy — but the persisted authority is ALWAYS the versioned canonical
  grant atoms RENDERED ON THE CARD the human approved: apply only an
  identical or provably-narrower scope; anything the revalidation would
  broaden, and anything no longer eligible, transitions to `cancelled` with a
  typed policy-change/reformulation result fanned out to live waiters (slot
  re-acquired first, dead waiters retired) and a fresh asking epoch opened
  with the revised scope on the card. No human click ever silently vanishes,
  no run strands, and no authority ever persists beyond what was displayed
  (policy-change-spanning test required). Then persist grant (live rule + job requirement CAS) → write signed responses (deterministic response IDs,
  consumer dedup) per waiter with per-waiter delivery tracking → `applied`.
  Grant application completes INDEPENDENTLY of waiter cleanup: lease-dead
  waiters are retired, so a dead runner can never wedge a grant. If an
  approval lands with NO live waiter (the race where the lease dies as the
  click wins), the need still reaches `applied` and the job's card surfaces
  [Run again now] — an approval is never stranded and never auto-runs.
- `denied_pending_delivery → denied`: same delivery discipline for the typed
  denial; the need is terminal only after delivery (or waiter retirement).
- Handoff is WAITER-scoped, not need-scoped (needs↔runs are many-to-many):
  a dead run's waiters are retired individually; a need stays `asking` while
  ANY live waiter remains. Only a need whose waiters are ALL dead converts
  its row to the [Approve & run again] + [Deny] form — and the rerun offer is
  ONE deduplicated, human-triggered run request PER DEAD RUN, enqueued only
  after every selected grant reaches `applied` (approving two rows from one
  dead run can never double-run). The aggregate card revises via the outbox;
  the message retires only when no live rows remain (two-need race
  validated).
Crash anywhere re-drives idempotently; a decided need can never strand a
waiter; a re-raised ask for an `applied` need auto-allows from the persisted
rule.

**Card-revision outbox.** Every card operation (send, living-card edit,
retire, replace) is a durable outbox entry with a card revision number,
executed with provider idempotency/readback where available. If a send/edit
outcome is ambiguous, the outbox reconciles (readback or bounded retry per
0124) before the next revision. Where delivery truly cannot be proven,
duplicate cards are tolerated SAFELY: every instance references the need, all
clicks are idempotent, and stale instances are retired on the next
reconciliation pass WHEN a message identity exists (readback or a later
callback supplies it); a provider that accepted a send but lost the response
and offers neither idempotency nor readback can leave an orphan duplicate —
accepted, since its clicks remain CAS/epoch-safe. EXPLICIT PRODUCT STANCE (owner-accepted): one visible
card is best-effort per provider capability (Telegram/Slack/Discord edits and
readback are used where they exist); click-safety and self-retiring stale
cards are the hard guarantee. Blocking approvals on provider send-identity
perfection is rejected as worse UX than a rare, harmless duplicate.

## Design

### A. The ask-and-wait lane

**A0. Readiness precondition.** A scheduled job must have a deliverable
approver route to be runnable — enforced at readiness. A run that could only
ever cancel never starts.

**A1. Host seam.** `ipc-permission-classifier-decision.ts:184-210`: no grant
matched → do not cancel — fall through to the interactive tail
(`:447 requestPermissionApproval`) raising the card against the need row.
Classifier stays OFF for autonomous runs (0121); the card path is
classifier-independent. Hard-boundary shapes bypass the ask entirely (typed
reformulation result — physics limit 1).

**A2. Wait commits only after CONFIRMED publication.** Need row → card via
the outbox (0124 machinery). Only a confirmed `delivered` outcome enters the
approval wait. Ambiguous outcomes live in a short bounded reconciliation
(readback/retry), never the full window. Exhausted/expired → `handoff_pending`
→ durable setup path; worker gets the `setup_required` result (D). No
invisible waits; no waiting on unconfirmed cards.

**A3. Worker wait.** `permission-callback.ts:265-276`: the autonomous lane
polls like interactive (`deadline = undefined`; omit `expiresAt` → no card
auto-cancel timer, 0053's mechanism). Signed jobId-bearing requests get the
24h `unbounded-interaction` authPurpose (`ipc-interaction-lifetime.ts:48-60`
gains the autonomous case).

**A4. Run-lease, the slot, and one restart rule.**
- The wait budget is ONE durable deadline per ASKING EPOCH:
  `wait_started_at + 24h`, where `wait_started_at` is set at CONFIRMED card
  delivery (A2) and reset only when a genuinely new question starts (a
  reopened/Reconsidered need starts a fresh epoch). The 24h auth window
  derives from the same anchor, so a valid waiter can always accept a
  response within budget and a reopened old need never expires on arrival.
  Expiry FREEZES the moment a decision CAS succeeds: lease and waiter auth
  remain valid through bounded response delivery (renewable host-issued
  waiter credential), so an approval accepted at 23:59 still resumes the run
  (last-second and clock-jump tests required). The run-lease extension (how much extra
  lease the run gets) is computed from host-monotonic heartbeat deltas over
  the union of open pending intervals, persisted as a clamped accumulated
  duration — wall-clock jumps can neither extend the lease nor prematurely
  expire it.
- Slot: RELEASED on entering permission-wait; re-acquired before the host
  writes ANY waking response (approval, denial, or degradation — uniform
  rule). Siblings never starve; wakeups never race a sibling.
- One restart rule: if the run lease is still alive (worker survived, host
  blip), the wait simply continues. If the run lease is dead (host restart
  killed the run, cap hit, worker died) → `handoff_pending`: retire card,
  raise pause card whose single action is [Approve & run again] — the late
  approval resolves the SAME need, persists the rule, and the SAME tap is the
  human's explicit rerun decision (physics limit 2: no automatic rerun after
  partial work, ever) — with [Deny] preserved beside it (same denial-memory
  transition as A7, no rerun enqueued): ignoring a card until the run dies
  never removes the right to say no. The tap durably records BOTH the decision and an
  idempotent human-originated run request in one transaction; the run request
  executes only after the grant reaches `applied` (crash cannot lose the
  promised rerun; callback retry cannot double-run).

**A5. One card, one approve action — by an AUTHORIZED actor.** Every card
callback (single-row, batch, Reconsider, Approve-&-run-again) authenticates
the clicking provider identity against the job's authorized approvers via the
existing identity-scoped approval authority (decision 0118 / PSCOPE
machinery). Route deliverability is NOT authorization: in a shared channel an
unauthorized member's click is rejected without resolving the need (and
without leaking card state). Validated per provider.
**[Allow always for this job] [Deny]** — everywhere a card exists. Grantable
needs only (single command, control-flow compound per #434's per-leaf rules,
capability, MCP tool) → persists as a scoped rule; suggestions route through
the existing durable-grantability logic so rule authority never exceeds the
boundary. (Hard-boundary shapes: no card — physics limit 1.)

**The living card (owner-directed UX).** One live card per JOB. A second need
arising while the first is unanswered EDITS the same message (next outbox
revision) into a checklist with **[Allow all & continue]** (per-row Deny
preserved). Batch actions are revision-bound: the click carries the card
revision + explicit need-id snapshot it was rendered with, CAS-resolved — a
need attached after that revision is NEVER covered by the click; it produces
the next revision (or a fresh card) and waits for its own answer. Nothing is
approved unseen. Card ownership is JOB-scoped: one need's handoff (its run
died/capped) CONVERTS that row to its [Approve & run again] form in place —
it never retires the living card while other needs are still asking; the
card retires only when the aggregate is empty.
**Allow-all atomicity + eligibility:** the batch decision (revision +
need-id snapshot) is persisted durably in ONE transaction before the provider
interaction is acknowledged; per-need application proceeds via the reconciler,
replay idempotent — a crash can never half-apply a click the provider
considers handled. The batch snapshot includes ONLY live `asking` rows;
handed-off rows are excluded from [Allow all & continue] and keep their
explicit per-row [Approve & run again] (label reflects this: "Allow all
pending"), so a batch tap can never rerun dead work implicitly. CAPACITY: the living
card is capacity-aware per provider (message/component limits): rows page
within the same edited card ("+N more — show"), the batch snapshot contains
ONLY visibly rendered rows, and over-limit behavior has adapter tests on all
three providers — Allow-all can never cover a row the user could not see — and within one
COMPOSITE row, approval binds the fully rendered canonical atoms: if a
provider truncates a large compound's rule set, approval is disabled for that
row until the full scope is shown (leaf pagination or full-scope view);
oversized-composite provider tests required.

**A6. Persistence + coalescing.**
- Allow-always → `approved_pending_apply` → reconciler (grant: live-rule file
  for same-run silent allow + `appendJobAccessRequirement` CAS; the
  setup-pause wiring's fingerprint short-circuit extended to derive the
  requirement from approved rules + jobId when `setupFingerprint` is absent;
  `requirementForRule` dedup) → per-waiter responses → `applied`. 0106
  intact: the human mutates the job via the card.
- Coalescing: identical needs attach as waiters to the one need row; the
  decision fans out via per-waiter delivery tracking (dead waiters retired;
  grant completion independent of cleanup).

**A7. Deny.** → `denied_pending_delivery` → typed denial delivered (slot
re-acquired first) → `denied`: terminal for that need. The resulting pause is
informational ("stopped: you denied Browser for this job") and raises NO
approval card for the same need. Future runs hitting the need short-circuit
to the same typed denial without asking. The job's actionable card (SCHED-4B)
shows denied needs with a one-tap "Reconsider" — reopening is always
user-initiated.

### B. Browser

No projection change. Lane A + the host's existing verdict
(`tool-rule-matcher.ts:286-291`: `Browser` grant → all five
`mcp__gantry__browser_*` names) auto-allows in milliseconds — no card, one
authorization source. Keep only the naming fix in the runner prompt
(`runner/index.ts:204-206`: use the real `mcp__gantry__browser_*` names).

### C. request_access, discoverability, and unprojected tools

- `mcp__gantry__request_access` is always-callable on autonomous runs (it
  grants nothing itself) and raises the same card through the same wait.
- **Discoverability (the model can't ask for what it can't see):** the runner
  prompt carries a lightweight CATALOG of EVERY requestable-but-not-projected
  identity — capabilities AND direct MCP/facade tools — names + one-line
  descriptions only, no schemas, no authority (source: the reviewed catalogs
  the host already holds). Invariant (validated): every requestable
  unprojected identity appears; nothing invisible is expected to be asked
  for.
- Registered-in-session need → on approve, proceed immediately (lane A).
- Unprojected need → on approve: grant persists; the tool result says exactly
  "Granted for this job; available from the next run"; the run terminates as
  "Completed with limits" (visibly incomplete, never a plain completion), its
  result names the missing tool, and the completion card carries
  [Run again now] (physics limit 2). No automatic rerun; no suppressed
  results; no duplicated side effects.

### D. Truthful status everywhere

- Waiting status lives on the card and the job's lifecycle line only; the
  suspended model sees nothing until a real result exists.
- Tool results: typed reformulation for hard-boundary shapes; explicit-deny
  reason on Deny ("The owner denied Browser for this job"); `setup_required`
  on degradation ("The approval question moved to a durable card; the job
  re-runs only if it is approved"); "granted; available next run" for the
  unprojected case. Never "waiting" as a result; never an "Allowed by…"
  string as a denial reason (fix `tool-permission-gate.ts:571` /
  `autonomous-permission-recovery.ts`).
- Agent guidance (one line, runner prompt): never avoid the better tool
  because it needs approval — asking is free; accuracy comes first.

## Deletions (single-cut mandate — owner directive 2026-08-23)

The implementation UNIFIES BY DELETION: scheduled runs ride the one
interactive permission path; the parallel autonomous permission lane is
removed, not bypassed. A PR that leaves the old autonomous branch alive
alongside the new path is wrong by definition. Deleted:

- `permission-callback.ts:265-276` — the autonomous hard-return, and the
  lane condition on unbounded wait (`unboundedInteractive`).
- The `autoClassifierWait` branch + `AUTO_PERMISSION_CLASSIFIER_WAIT_MS`
  (a wait for a classifier 0121 already removed from autonomous runs).
- `ipc-permission-classifier-decision.ts:184-210` — the hostJobId cancel
  branch (rails still answer first; no-match falls through to the one tail).
- `permission-ipc-client.ts:228-239` — the duplicate hard-return in the
  second runner lane.
- The interactive-only condition in `ipcInteractionAuthValidationOptions`
  (one auth-lifetime rule for any signed interaction).
- `GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS` special-casing (one
  permission-timeout rule).
- The no-grant "unattended run" denial prose in
  `denyNonPromptableAutonomousRecovery` / `autonomous-permission-recovery.ts`
  (only explicit-deny and hard-boundary-reformulation texts remain; the
  "Allowed by…" gaslight dies here).
- The no-grant→terminal-denial→setup-card re-carding loop (replaced by the
  need row; the setup card remains only as the handoff target).

What stays autonomous-SPECIFIC is policy, not plumbing: rails-first with no
classifier (0121), the job card's action set (no Allow-once), and the
job-requirement append on approve. Net non-test line count outside the
need-store/outbox goes DOWN; the need-store/outbox REPLACE ad-hoc handoff
code rather than adding alongside it.

## Scope

- IN: A (lane + living card + need model + outbox), B (naming fix), C
  (incl. catalog), D; one new decision record.
- OUT — NOTIFY-3 (separate, already approved): terminal result-card
  rendering.
- OUT — JOBPERM-2: in-session dynamic reprojection (upgrades physics limit 2
  to in-place continuation).
- OUT — JOBPERM-3 (phase 2 UX, owner-endorsed): inferred toolbox card at job
  creation (extends PREFLIGHT-1) + completion-receipt "Add to toolbox"
  upgrade. Demotes mid-run asks from routine to rare.
- Untouched: interactive/chat behavior; 0121 classifier exclusion; the pipe
  boundary (REAFFIRMED — physics limit 1); 0106; 0056; #434's deterministic
  fast path.

## Decisions to record

"Autonomous runs ask-and-wait (chat parity)": no-match on a grantable need
asks a durable in-channel question with in-place resume; approvals are
permanent and job-scoped; explicit denial is terminal per-need with
user-initiated reconsideration; hard-boundary shapes are reformulation-only
(pipe boundary reaffirmed); unprojected grants land next-run with an honest
result and human-initiated rerun. Supersedes the cancel consequence of 0121;
amends 0115.

## Validation plan

Unit: seam (grantable no-grant + route → card, no cancel; hard-boundary →
typed reformulation, no card, no need row); confirmed-only wait (ambiguous
bounded, exhausted degrades); worker polls and resumes; single durable
deadline (auth and cap share the anchor; lease extension monotonic under
skew/restart/overlap); slot released on wait + re-acquired before EVERY
waking response; persistence without setupFingerprint (dedup); revision-bound
batch (need attached after render is never covered by Allow-all; gets next
revision); coalescing fan-out with per-waiter tracking (dead waiter retired,
grant still completes, surviving waiters resume exactly once); deny
delivery-then-terminal (crash between record and delivery re-drives; no
re-ask across runs; Reconsider reopens); handoff idempotency (crash between
retire/raise; stale-card click resolves the need); outbox ambiguity
(duplicate card tolerated, clicks idempotent, stale retired); unprojected
grant (persisted, honest result, no auto-rerun, Run-again present); catalog
present in prompt; denial-text truthfulness.
Provider adapter contract tests (Telegram, Slack, Discord): send,
edit-to-checklist, revision-bound + epoch-bound actions, unauthorized-actor
rejection, retire/replace, ambiguous delivery, duplicate callbacks, late
stale-card clicks.
Live scenario 1 (in-session continuation, KnackLabs): prompt needing a
projected-but-unruled tool → ONE living card in Telegram → authorized approve
→ the RUN CONTINUES IN PLACE and completes → next run silent-allows →
requirement visible in `gantry jobs show`.
Live scenario 2 (unprojected tool): prompt needing an unprojected identity →
request_access card → approve → run terminates "Completed with limits" naming
the missing tool → explicit [Run again now] tap → rerun uses the tool.
Live scenario 3 (deny, throwaway job): informational stop, no re-ask across
runs, Reconsider visible and reopens a fresh epoch.
