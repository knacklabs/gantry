# JOBPERM-1-T2 — Durable needs, reconciler, living card

Contract: v9 Core model + A2/A4/A5/A6/A7 (the durability the T1 stage review
deferred here). T1's lane is live on this branch; T2 makes it crash-safe and
one-card.

1. Need rows (jobId + canonical need identity, asking_epoch) in the durable
   pending-interaction store; states asking/approved_pending_apply/applied/
   denied_pending_delivery/denied/handoff_pending/handed_off/cancelled.
2. One idempotent reconciler: apply-time revalidation (card-rendered scope,
   never broader), grant persist + per-waiter signed responses (deterministic
   ids, dedup, dead-waiter retirement), denial delivery, handoff transitions.
3. Card-revision outbox for send/edit/retire/replace; living card per job:
   checklist edits, [Allow all pending] revision+epoch-bound, atomic batch
   persist before provider ack, capacity-aware paging; actor authorization
   (0118) on every callback.
4. Wait anchored at confirmed delivery (wait_started_at, shared with auth);
   lease extension from host-monotonic pending intervals; slot released on
   wait and re-acquired before ANY waking response; 24h cap -> handoff.
5. Handoff: waiter-scoped; row converts to [Approve & run again]+[Deny];
   deny durable per-need with Reconsider epoch; coalescing by need id.
6. Tests: TOP-LEVEL it() ids jobperm-1-t2-reconciler-crash-safe,
   jobperm-1-t2-living-card-revision-bound, jobperm-1-t2-handoff-and-deny-memory
   in apps/core/test/unit/application/jobperm-durability.test.ts, plus focused
   suites for every touched module.

Verify: required JUnit green; check_dual_runtime; autoreview vs the v9 doc.

BINDING CONTRACT LOCATION: read plans/review-briefs/scheduled-job-permission-parity-design.md (committed, 8839e40b2) — it contains the full Core model and sections A2/A4/A5/A6/A7. Do not guess any transition; every state, wait, outbox, and handoff rule is specified there. 0124 stands (use outbound-delivery entries, not an embedded delivery state machine).


# INLINED BINDING CONTRACT (v9 Core model + section A verbatim)

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


# REVIEW FIXES REQUIRED (stage autoreview vs v9 — fix all four before done)
1. job-permission-durability.ts:437 — a stale allow click from a revision that
   rendered only "Allow always" must NEVER populate rerunRunIds after handoff:
   preserve the grant, enqueue a rerun ONLY from an action whose rendered row
   was approve_and_run_again; otherwise publish the handoff card for consent.
2. :1413 — implement a real revision-bound paging ACTION (page cursor) so every
   hidden row can be rendered and decided; no permanently hidden rows.
3. :1076 — durable run-scoped barrier: enqueue a dead run's rerun only after
   EVERY selected grant for that run reaches applied (two-row approval race).
4. job-permission-durability-wiring.ts:97 — apply-time revalidation must invoke
   the CURRENT policy evaluator (rails/grantability), then accept only an
   identical-or-narrower result than the rendered atoms — never the stored
   snapshot alone.
Rerun the three jobperm-1-t2-* proofs + focused suites after fixing.

# REVIEW FIXES ROUND 2 (stage re-review — all contractual under AC5)
1. Track card delivery PER CARD REVISION (not the need's one-time waitStartedAt
   skip): later edits must have their outcomes checked; stale-card-forever bug.
2. Ambiguous send outcomes get bounded readback/retry reconciliation BEFORE any
   handoff degradation (0124 states); never treat ambiguous as exhausted.
3. Discord: send the success acknowledgement ONLY after decideCardAction
   durably accepts (defer the interaction if needed); bound labels/text to
   provider limits with a full-scope view for overflow.
4. Renew/issue the 24h waiter credential from the CONFIRMED-DELIVERY anchor
   (not request write time); freeze through bounded response delivery.
5. Handoff race: an approved grant on a dead run must never strand without its
   rerun action; grant application crash window must be covered by the
   reconciler (idempotent re-drive from approved_pending_apply).
(Unprojected-tool truthful next-run path is T3 scope — do NOT build it here.)
Rerun jobperm proofs + focused suites after fixing.

# REVIEW FIXES ROUND 3 (contractual under AC5; T3 items are FENCED — skip them)
1. Attach a durable need ONLY after rails and persisted grants miss (never
   create needs/cards for calls the deterministic fast path would allow).
2. Persist the job requirement on allow-always in ALL paths (audit every
   decision path reaches appendJobAccessRequirement).
3. Retain the policy-relevant tool input in the durable request snapshot so
   apply-time revalidation evaluates the REAL call, not a lossy summary.
4. STILL MISSING from round 2: ambiguous card delivery gets bounded
   readback/retry reconciliation BEFORE handoff (0124); implement it this time.
5. Slots must release for needs hidden by pagination (a hidden row's waiter
   must not hold the workspace slot).
6. Paginate full compound scope within provider message limits (no oversized
   payload rejections).
FENCED to T3 (do NOT build): the unprojected-tool truthful next-run flow.
Rerun proofs + focused suites; commit your work.
