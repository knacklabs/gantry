# JOBFLOW epic — PLAN v15 (post fourteen adversarial passes) + validation brief

Repo: /Users/ravikiranvemula/Workdir/myclaw (baseline main + PR #414 content,
branch fix/recovery-proposal-projection). READ-ONLY validation, pass 15.
Passes 1-14 folded in. Pass 14 found EXACTLY ONE remaining PLAN blocker —
the outbound aggregate idempotency key was not generation-aware — resolved
in the shared contracts section (`setup_permission_prompt:<promptId>:
<generation>`, allocated under the prompt lock; same-generation replay
returns the same aggregate). All nine pass-13 resolutions were validated
correct. S2a/S2b/S4 were judged ready after S1; S5 dependency-blocked only
by S3's identity fix. This pass is a CONFIRMATION pass: verify the
generation-aware aggregate identity against the code, confirm no new
PLAN-level gap exists anywhere, and give the final per-story verdict.
Pass 13's nine PLAN items previously resolved: the
Anthropic protected-capability and memory-boundary guards ENTER the
terminal sweep (0115:53 excludes only model-validation/wait-only/network
guards); the canonical eleven-row Surface Impact Matrix replaces my
homemade one; the contradictory prepared-send deferral line is deleted;
setup.deliveryNotice is the named display seam; the separate projection
row is DELETED (outbound item = operational projection); exhausted-resume
uses a new DELIVERY GENERATION on the same prompt; claimed→superseded is
allowed only for authoritative target invalidation; recovered-tap
terminalization waits for FULL durable settlement; mixed-glob templates
are ineligible for compilation. Fully self-contained. DECOMP items in the
ledger are NOT plan blockers. Verify; verdict per story with file:line;
classify remaining gaps PLAN vs DECOMP; simplicity audit;
implementation-ready verdict.

## Goal

A scheduled job pauses only with a card the owner can act on (bounded-delivery
guarantee with defined recovery for every terminal outcome), every TERMINAL
AUTONOMOUS denial in JOBFLOW scope is typed and observable (per 0115:53 the
ONLY exclusions are Anthropic model-validation, wait-only, and network
guards; the protected-capability guard tool-permission-gate.ts:299 and
memory-boundary guard :334 ARE in scope and become terminal producers —
S1 also reconciles autonomous-jobs.md:88's overbroad "every denial"
sentence), job prompts carry business logic only (the KnackLabs prompt
sweep is INSIDE the S5 gate, its text owner-approved), and the system files
recognized fixes itself — human approval stays the sole authority.

## Stories and dependencies

S1 docs → S2a typed-denial event cutover → S2b tagged-action cutover →
S3 card delivery (depends S2b) and S4 fix proposals + guidance (depends S2a
AND S2b) → S5 live ACCEPTANCE GATE (depends S2-S4).

## Evidence gate (pre-implementation, not a story)

Read-only redacted forensic snapshot for
job-knacklabs-lead-maintenance-43527c192a6e (telegram, tg:-1003986348737):
setup_state/pause/notified_fingerprint, events, pending_interactions ⋈
permission_prompts (envelope_id -> id), outbound
deliveries/items/receipts/locators. Output: dated note in docs/memory/.

## Shared persisted contracts (referenced by multiple stories; land with
their first user, recorded in S1)

- EVENT IDEMPOTENCY (S2a-P2 + J11-2/J11-3 resolved): runtime events gain
  ONE nullable idempotency_key text column; PARTIAL UNIQUE index on
  (app_id, idempotency_key) WHERE idempotency_key IS NOT NULL (events are
  app-scoped; schema events.ts:20; append today unconditional,
  runtime-event-repository.postgres.ts:182). Keys are NAMESPACED:
  `tool_denied:<runId>:<denialFingerprint>` (S2a),
  `card_delivery_terminal:<promptId>:<generation>` (S3 — ONE terminal
  outcome per delivery generation, first wins; generation = the ordinal of
  the outbound aggregate for that prompt, allocated while the prompt is
  locked), `card_delivery_expired:<promptId>` (S3 expiry).
- OUTBOUND AGGREGATE IDENTITY (pass-14 final blocker resolved): the
  permission-card delivery aggregate's idempotency key is
  GENERATION-AWARE — `setup_permission_prompt:<promptId>:<generation>` on
  the existing (app_id, idempotency_key) uniqueness
  (schema outbound-delivery.ts:40,62; enqueue returns the existing row on
  match, repository :59). Same-generation replay returns the same
  aggregate; a successor generation produces a distinct aggregate.
  Generation is allocated under the prompt lock in the same transaction
  that enqueues.
  There is NO retrying event (J11-3 dissolved by deletion): attempt count
  and next-attempt state already live on the outbound item
  (outbound-delivery.ts schema :112). CONFLICT SEMANTICS (J11-2):
  insert-on-conflict-do-nothing returning the existing row, and on
  conflict ALL downstream side effects are SKIPPED — no event-bus outbox
  envelope, no webhook enqueue (today append always publishes after
  insert, runtime-event-repository.postgres.ts:112, and the outbox mints a
  fresh random id, event-bus-outbox.postgres.ts:49 — the conflict branch
  returns before the publish step). Callers treat conflict as
  already-recorded success. Null key = today's behavior.
- RECOVERY COORDINATOR: one periodic tick (the existing 5s loop,
  runtime-services.ts:928) invokes SEPARATE services: outbound delivery
  recovery (existing, outbound-delivery-recovery.ts) and the S4 amendment
  intent recovery (new, own service — NOT folded into the S3 repository).

## S1 — Decision + spec reconciliation (docs only; written after pass-11
stabilizes contracts, merged before any code story)

- AMEND 0117 (accepted lost/duplicate cards, 0117:47,:51) + echoes
  preflight-1.md:32, autonomous-jobs.md:83, the accepted-hang comment
  contract execution-readiness.ts:209. New contract: bounded durable card
  delivery (cap 4, outbound-delivery-service.ts:22); the outcome set and
  transition graph below; setup event publish reordered before delivery.
- AMEND 0122 (agent authorship :25, argv identity :44; spec
  capability-template-amendment.md:36,:79,:85): host-only entry; identity =
  (appId, capabilityId, canonical proposedTemplates); ONE redacted argv
  sample; BOTH pinned-path templates; supersession keeps
  denied/system:superseded; canonical_key real data migration.
- AMEND 0123 (S1-P1 resolved): 0123:36,:45 say agent request_access makes
  0122 reachable and amendments surface through birthright tools — S4
  removes the agent-authored amendment path, so 0123's amendment-surfacing
  language is superseded (request_access itself and the other birthright
  recovery tools REMAIN; only the capability_template_amendment proposal
  target goes host-only).
- RECONCILE 0115 (0115:22): declarative denials terminal on scheduled runs;
  recognized mismatch -> fix_proposal; grantable-as-concept disappears.
- RESOLVE D-0057 (deferrals.md:65) via S4's durable intent (S4-P1/P2 terms
  below) — stated as closed by this epic.
- S1 carries the TRANSITION GRAPH + IDEMPOTENCY KEY TABLE as its appendix
  (the graph in this plan is normative input to it), plus the CANONICAL
  SURFACE IMPACT MATRIX (pass-13 corrected — the contract's OWN eleven
  rows, .codex/skills/gantry-change-contract/SKILL.md:14):
  1. Runtime: CHANGED (S2a/S3 core; scheduler/execution/delivery).
  2. settings.yaml: UNCHANGED BY DESIGN (capability definitions live in
     tool_catalog, not mirrored to settings — 0122:53).
  3. Postgres/runtime projection: CHANGED (event idempotency column,
     prompt identity columns, outbound cancelled/checkpoint columns,
     migrations).
  4. Control API: CHANGED (S2b wire union + setup.deliveryNotice; pending
     list unchanged).
  5. SDK/contracts: CHANGED (authored setup schema + regen).
  6. CLI: CHANGED (action + deliveryNotice rendering via shared formatter).
  7. MCP/admin skill: CHANGED (scheduler formatters; capability amendment
     tool REMOVED, S4).
  8. Channel/provider adapters: CHANGED (all four: typed result +
     prepared-send ports + bounded card render).
  9. Docs/prompts: CHANGED (S1 amendments; S4 run-guidance block;
     autonomous-jobs.md:88 reconciliation).
  10. Audit/events: CHANGED (extended JOB_TOOL_DENIED,
      job.setup_card_delivery, idempotency).
  11. Tests/verification: CHANGED (replaced-pins families + story-level
      proofs + S5 gate).
  (Web/UI: auxiliary note — not applicable, no UI surface exists.)
  PREPARED-SEND SCOPE: prepared-send ports for ALL FOUR adapters are IN
  S3 SCOPE — the setup-pause path is provider-neutral
  (setup-pause-permission-wiring.ts:119; pinned Slack routing,
  setup-pause-prompt.test.ts:1877); telegram-only would regress
  non-telegram setup cards. Each port is a small non-waiting factoring of
  that adapter's existing card-send code. The S5 LIVE gate remains
  telegram. The CAPFIX-1 roadmap agent-raised claim (roadmap.json:1166)
  is marked HISTORICAL, superseded by host-only authorship.
- 0121 unchanged. JobPrimingService cleanup out of scope.

### S1 normative transition graph

The two axes are independent. Prompt lifecycle says whether a human decision is still
meaningful; the outbound item/aggregate is the operational delivery projection for one
generation. Terminal delivery does not by itself settle an open prompt.

| Axis | From | Trigger | To | Required effect |
|---|---|---|---|---|
| Prompt lifecycle | open | Human claim acquired | claimed | Exclude from blind expiry/cancel sweeps; preserve the claim for settlement retry. |
| Prompt lifecycle | open | Full durable decision settlement | settled | Terminalize the provider card only after authority application and prompt/member settlement both complete. |
| Prompt lifecycle | claimed | Full durable decision settlement | settled | Same full-settlement fence; authority application alone is insufficient. |
| Prompt lifecycle | open | 24-hour TTL | expired | Expire the pending member, clear `notified_fingerprint`, append the expiry event; resume creates a new prompt row. |
| Prompt lifecycle | open | Job/delivery cancellation | cancelled | Cancel the pending member and make callbacks answer inactive. |
| Prompt lifecycle | open | Fingerprint or target invalidation | superseded | Supersede the pending member and make callbacks answer inactive. |
| Prompt lifecycle | claimed | Authoritative target invalidation only | superseded | Observe supersession before applying authority; blind sweeps never clobber a claim. |
| Delivery generation | pending | Lease-fenced `beginSend` | dispatching | Persist `send_begun_at` before the provider call. |
| Delivery generation | dispatching | Provider send settles successfully | delivered | Attach the provider locator in the settlement transaction; keep the prompt active until decision settlement. |
| Delivery generation | dispatching | Claim expires after `send_begun_at`, or transmission is unknown | ambiguous | Never retry this generation; keep the prompt open and expose owner recovery through `setup.deliveryNotice`. |
| Delivery generation | dispatching | Provably-pre-transmission failure (delivered:'no', retryable) or claim expires with `send_begun_at` NULL, below the attempt cap | pending | Increment the attempt count, set `next_attempt_at` backoff, clear `send_begun_at`; the recovery tick re-claims and `beginSend` runs attempt N+1. |
| Delivery generation | pending or dispatching | Attempt cap 4 reached without delivery | exhausted | Keep the prompt open, clear `notified_fingerprint`; resume enqueues a new generation on the same prompt. |
| Delivery generation | pending or dispatching | Cancellation wins the send fence | cancelled | Terminalize this generation and cancel the prompt only while it is open. |
| Delivery generation | exhausted | Owner resumes | pending (new generation) | Allocate the next generation under the prompt lock; never reopen a terminal outbound item. |

### S1 normative idempotency-key table

| Record | Key | Uniqueness / allocation | Replay or conflict result |
|---|---|---|---|
| `JOB_TOOL_DENIED` runtime event | `tool_denied:<runId>:<denialFingerprint>` | Partial unique `(app_id, idempotency_key)` where the key is non-null. | Return already-recorded success and skip every downstream side effect, including event-bus outbox and webhook enqueue. |
| `job.setup_card_delivery` terminal generation event | `card_delivery_terminal:<promptId>:<generation>` | Same runtime-event partial unique; one terminal outcome per delivery generation, first wins. | Return already-recorded success and skip downstream side effects. |
| `job.setup_card_delivery` prompt-expiry event | `card_delivery_expired:<promptId>` | Same runtime-event partial unique; one expiry truth per prompt. | Return already-recorded success and skip downstream side effects. |
| Permission-card outbound aggregate | `setup_permission_prompt:<promptId>:<generation>` | Existing unique `(app_id, idempotency_key)`; allocate generation under the prompt lock in the enqueue transaction. | Same-generation replay returns the same aggregate; a successor generation creates a distinct aggregate. |

Null runtime-event idempotency keys retain the existing append behavior. The lowest
persisted `event_id` per run is authoritative for terminal-denial reads.

### S1 canonical eleven-surface matrix

| Surface | Classification | Contract |
|---|---|---|
| Runtime behavior | Changed | S2a/S3/S4 change scheduler execution, terminal-denial handling, card delivery, and host-filed recovery. |
| `settings.yaml` | Unchanged by design | Capability definitions remain in `tool_catalog`; settings selects capabilities and never mirrors command-template definitions (0122/0125). |
| Postgres/runtime projection | Changed | Add event idempotency, prompt identity, outbound generation/checkpoint/cancellation, approval-intent state, and their migrations. |
| Control API | Changed | S2b carries the tagged setup action and `setup.deliveryNotice`; the pending-list concept remains. |
| SDK/contracts | Changed | Author the setup schema and regenerate the typed contract. |
| CLI | Changed | Render the tagged action and delivery notice through the shared formatter. |
| Gantry MCP tools/admin skill | Changed | Update scheduler formatters and remove the agent-authored capability-amendment tool target. |
| Channel/provider adapters | Changed | Telegram, Slack, Teams, and Discord adopt the typed result, prepared-send ports, and bounded single-card render. |
| Docs/prompts | Changed | S1 reconciles decisions/specs/architecture; S4 adds the shared scheduled-run guidance block. |
| Audit/events | Changed | Extend `JOB_TOOL_DENIED`, add `job.setup_card_delivery`, and enforce namespaced idempotency. |
| Tests/verification | Changed | Replace obsolete pins, add story-level falsifiers, and run the S5 live fault matrix. |

Web/UI is an auxiliary `Not applicable` surface: no web UI exists for this flow.

## S2a — Typed terminal-denial EVENT cutover

- REUSE JOB_TOOL_DENIED (runtime-event-types.ts:21; emitted
  execution.ts:737; payloads typed unknown, events.ts:51 — no production
  payload consumer breaks, confirmed pass 10). EXTENDED payload (persisted
  names): {denied_tool, reason, denial_kind: permission_denied |
  rule_denied | capability_template_mismatch, provenance_lane: anthropic |
  deepagents | host, provenance_seam: gate | recovery | declarative |
  capability_run, grantable, recovery_action, recovery_kind} —
  grantable/recovery_* retained verbatim until S2b (current divergence
  execution-diagnostics.ts:26,56; persisted names win).
- EVENT→ACTION CONTRACT (pass-12 gap resolved): in the SAME S2b cutover
  that deletes the recovery-string parser, the event payload's
  grantable/recovery_* fields are REPLACED by the typed action object —
  {action: {kind:'approve_grant', grant: PermissionAuthorityAddition} |
  {kind:'fix_proposal', proposal_id} | {kind:'instruction', text}} — so
  the durable event IS the source finalization/readiness build blockers
  from after S2b (finalization today has only tool/grantable/
  recovery-string data, execution-diagnostics.ts:48; no string parsing
  survives). Producers emit the typed action at denial time; the host
  fix_proposal producer records the proposal first and embeds its id (S4).
- ORDERING + REQUIRED PERSISTENCE (S2a-P1 + J11-1 resolved, pass-12
  corrected): the terminal-denial event is appended BEFORE finalization
  consumes it — today finalization updates the job at execution.ts:633 and
  the event appends after at :737; the append moves ahead of finalization
  in the run epilogue AND uses a REQUIRED (non-swallowing) append —
  bypassing the catch-and-suppress emitter
  (execution-runtime-events.ts:139). APPEND-FAILURE SEMANTICS (corrected —
  throwing past finalization would only hit the failsafe, which finalizes
  the lease without requeueing the job, execution.ts:814,
  run-failsafe.ts:24): an append failure is CONVERTED into a run error
  handed INTO finalization with the denial cleared — finalization's
  existing `error && !toolDenial` branch (execution-finalization.ts:167)
  then retries the run normally. The denial re-derives on the retry. No
  silent divergence between event store and job state.
  PRIMARY-DENIAL RULE: lowest persisted event_id per run is authoritative
  (read seam orders ascending, runtime-event-repository.postgres.ts:249);
  later denials recorded (distinct fingerprints) but not consumed.
- DENIAL FINGERPRINT: hash(runId, denied_tool, denial_kind,
  provenance_seam). Idempotency key per the shared contract.
- DURABLE READ SEAMS: finalization input gains the runtime-event list port
  (execution-finalization.ts:40; runtime-event-exchange.ts:103); status
  formatting takes the typed record instead of parsing summary strings
  (status-formatting.ts:9,21); visibility gains the event read
  (job-visibility-metadata.ts:302,309,437). In-run fast path may use the
  in-memory copy; durable read authoritative.
- Producers: tool-permission-gate.ts:385,538,550 PLUS the
  protected-capability guard (:299) and memory-boundary guard (:334) —
  both currently return non-interrupting denials but are NOT among
  0115:53's exclusions (model-validation/wait-only/network only), so they
  become terminal producers on scheduled runs (pass 13);
  autonomous-permission-recovery.ts:15; third-party-mcp-gate.ts:39 ->
  deep-agent-runner.ts:234,273; mcp-tools.ts:262 (terminal per S1). Host
  lane lands in S4.
- ACCESS PREFLIGHT: delete assertToolAccessRequirementsReadyForRun
  (execution-tool-access-requirements.ts:11); readiness-first with fresh
  snapshot (execution.ts:345,377,385; job-readiness-service.ts:162;
  execution-readiness.ts:128; execution-finalization.ts:137).
- MARKER PARSER deleted; isGrantableAutonomousToolRecovery RETAINED/moved
  for its two runner-lane importers (S2a-D2 accepted;
  autonomous-tool-denial.ts:9).
- S2a leaves the action representation fully intact.

## S2b — Tagged setup-ACTION cutover (depends: S2a)

- Domain union (job-types.ts:73,88): approve_grant{grant:
  PermissionAuthorityAddition — NEW NARROW type covering only validated
  allow-rule additions/replacements (permission-decision.ts:72), not the
  full PermissionApprovalUpdate (types.ts:296)} | fix_proposal{proposalId}
  | instruction{text}. Canonical grant subject = (rule kind, canonical rule
  subject string). Action identity: approve_grant = hash(discriminant +
  subject); fix_proposal = proposalId; instruction = hash(text). Priority
  approve_grant > fix_proposal > instruction, ties lexical
  (job-readiness-service.ts:508). Recovery-string parser deleted
  (setup-pause-permission-prompt.ts:443).
- STRICT PARSER SEMANTICS (S2b-P1 resolved, 0112:21 choice made): malformed
  setup_state raises a SPECIFIC REMEDIATION ERROR naming the job and the
  offending fragment — never ignore, never partial acceptance (today
  silent undefined/partial, canonical-job-target-state.ts:4,20,49 —
  storage parser only). Invariants: ready implies no blockers; non-ready
  implies >=1 valid; top-level = highest priority; unique action
  identities; no partial arrays. camelCase dual reads removed.
- EXTERNAL EVENT SCHEMA (S2b-P2 resolved — today the two JOB_SETUP_REQUIRED
  writers disagree: execution emits selected snake-case fields,
  execution-readiness.ts:269; management emits full camelCase blocker
  objects, job-management-readiness.ts:135): ONE shape for both writers —
  snake_case, full blocker objects:
  {blockers: [{id, state, type, summary, action: {kind:'approve_grant',
  grant, summary} | {kind:'fix_proposal', proposal_id, summary} |
  {kind:'instruction', text}}], setup_fingerprint}. The API/SDK/CLI wire
  mirrors it (camelCase per transport convention, one mapper).
- WIRE: blockers[].action = union; blocker nextAction/grantable removed;
  top-level setup.nextAction + health.nextAction retained as derived
  strings via ONE formatter (replaces job-setup-labels.ts:53);
  recovery.nextAction same formatter.
- Inventory: job-readiness-service.ts:162,395,469,508;
  capability-readiness.ts:100; setup-pause-permission-prompt.ts:309,443;
  job-management-readiness.ts:123,135,147; execution-readiness.ts:269,277;
  scheduler-setup-story.ts:19; guided-actions.ts:130;
  job-permission-recovery.ts:201; request-access-job-recovery.ts:75;
  ipc-interaction-processing.ts:567; ipc-scheduler-create-handlers.ts:205;
  ipc-scheduler-mutate-handlers.ts:310; contracts jobs/index.ts:150,206;
  routes/jobs.ts:364; SDK job-model-types.ts:28,45; cli/jobs.ts:16,401;
  scheduler-formatters.ts:104,168; job-visibility-metadata.ts:99. OpenAPI
  authored (openapi-schemas-automation.ts:109,150) then regenerated
  (generated/openapi.ts:3213).
- MIGRATION: offline, total; legacy non-ready rows -> typed instruction
  ("This job paused under the old format; resume to re-check."); recompute
  fingerprint, set notified_fingerprint equal (no storm;
  job-readiness-service.ts:469).

## S3 — Card delivery on the outbound subsystem (depends: S2b)

- PROMPT IDENTITY: new prompt row per issue; prompt schema gains job_id +
  setup_fingerprint; PARTIAL UNIQUE across ALL NON-TERMINAL lifecycle
  states. RETENTION (S3-P6 resolved): job_id is a PLAIN INDEXED COLUMN, no
  FK constraint — cancelled prompt/interaction/delivery rows SURVIVE job
  deletion as audit history (integrity guaranteed by the one-transaction
  delete/cancel below, not by cascade).
- LIFECYCLE GRAPH (S3-P4 + pass-12 claim-precedence resolved — existing
  states retained, worker-coordination.ts port :123, repository
  transitions :207,:355): Axis B (prompt lifecycle): open -> claimed ->
  settled; OPEN ONLY -> expired | cancelled | superseded — CLAIMED prompts
  are EXCLUDED from expiry/cancel sweeps: an acquired human claim is never
  clobbered; a claimed prompt follows the existing claim-retry protocol
  (apply/resolve failure preserves the claimed intent for retry — pinned
  behavior, pending-interaction-durability.test.ts:2029, stands).
  review_each_expired retained with its current transitions. NON-TERMINAL
  = open, claimed (the partial unique covers both). RECOVERED-TAP
  ORDERING (pass-12 + pass-13 tightened): durable recovery terminalizes
  the provider card only AFTER FULL durable settlement completes — i.e.
  after durable authority application AND prompt/member settlement
  (resolveDurablePermissionInteractionByRequestId returns true) — not
  merely after authority application (application can succeed while
  member settlement fails and must stay retryable,
  pending-interaction-permission-callback.ts:516,534; today the card is
  terminalized first, pending-interaction-permission-recovery-
  orchestrator.ts:145). CLAIMED-TARGET INVALIDATION (pass 13): blind
  expiry/cancel sweeps stay open-only, but AUTHORITATIVE target
  invalidation (job deletion, fingerprint supersession) may transition
  claimed -> superseded under the same claim lock; the callback observes
  supersession BEFORE applying authority — no claim is ever left
  nonterminal against a dead target. Axis A (delivery outcome — the
  OUTBOUND ITEM/AGGREGATE IS the operational projection, no separate
  projection table, pass 13): pending -> dispatching -> delivered |
  ambiguous | exhausted | cancelled (terminal per GENERATION). CANCEL/
  SEND RACE (S3-P3): cancellation committed BEFORE a successful
  beginSend -> claim invalidated, Axis A terminal cancelled;
  cancellation/expiry committed AFTER beginSend -> Axis B transitions
  ONLY if the prompt is open (never claimed except authoritative
  invalidation above), Axis A resolves on settlement/lease outcome.
- DELIVERY GENERATION (pass 13 — exhausted resume was impossible: enqueue
  idempotency returns the existing aggregate, terminal items stay failed,
  recovery claims only pending,
  outbound-delivery-repository.postgres.ts:59,325, claims :127): the SAME
  open prompt may have SUCCESSIVE outbound aggregates — resume after
  exhausted enqueues a NEW aggregate (generation = ordinal, allocated at
  enqueue); terminal outbound items are never reopened. One terminal
  event per (promptId, generation).
- EVENT CONTRACT (S3-P1 + J11-3 + generation): new registered runtime
  event 'job.setup_card_delivery' (registry runtime-event-types.ts:1).
  Payload: {prompt_id, generation, job_id, setup_fingerprint, outcome:
  delivered | ambiguous | exhausted | cancelled | expired, attempt,
  provider, detail?}. TERMINAL Axis-A outcomes = delivered, ambiguous,
  exhausted, cancelled — idempotency key
  `card_delivery_terminal:<promptId>:<generation>`. There is NO retrying
  event — attempt/next-attempt state is read from the outbound item
  (schema :112). expired is an Axis-B event reusing the same event type,
  key `card_delivery_expired:<promptId>`.
- DISPLAY SEAM (pass 13 — visibility cannot express Axis A today,
  job-visibility-metadata.ts:41,113; scheduler output forwards existing
  fields, ipc-scheduler-query-handlers.ts:234): NEW field
  setup.deliveryNotice: {outcome, attempt, text} | null, derived through
  S2a's event read from the LATEST job.setup_card_delivery event for the
  current prompt/fingerprint; carried through Control API, contracts/SDK,
  CLI, and the shared scheduler formatter. "Notice" is list/detail/status
  PRESENTATION only — never a second outbound notification.
- TRUTHFUL EVENTS vs CONDITIONAL PROJECTION (S3-P2 resolved): the
  prompt-scoped terminal delivery event is ALWAYS appended — even when the
  job's fingerprint moved on or the job is deleted (delivery truth is
  never suppressed). Only the JOB projection (notified_fingerprint CAS +
  blocker action update) is CAS-conditional: CAS miss -> reread and
  classify (stale fingerprint | deleted job) -> skip the job projection
  only (canonical-job-coordination.postgres.ts:54).
- AXIS-A → PROMPT/MEMBER MAPPING + OWNER RECOVERY (S3-P5 + J11-4 + the
  pass-12 fingerprint-stability fix): ambiguous/exhausted are
  DISPLAY-LEVEL ONLY — the job's BLOCKER, its action, and its
  setup_fingerprint NEVER change while the prompt lives (action identity
  participates in the fingerprint, job-readiness-service.ts:469, and
  approval validation requires prompt fingerprint == current job
  fingerprint, setup-pause-permission-wiring.ts:237 — mutating the
  blocker would invalidate the very prompt the owner can still answer).
  The owner-recovery texts below are status/notice PRESENTATION (from the
  Axis-A projection), not blocker mutations.
  - delivered: prompt OPEN, member PENDING; card active; decision resolves.
  - ambiguous: prompt OPEN, member PENDING — the callback alias was
    pre-bound at creation, so a card that DID reach the chat stays LIVE
    (a tap is a real decision via the durable callback,
    channel-connect.ts:600); pending-list approval uses the SAME member
    (worker-coordination-permission-prompt.postgres.ts:475); status
    notice: "A prompt may have been sent but could not be confirmed. Tap
    it if you got it, or approve from the pending list."
  - exhausted: prompt OPEN, member PENDING; status notice: "We couldn't
    deliver the approval prompt after several attempts. Approve from the
    pending list or resume the job to try again."; notified_fingerprint
    cleared (a resume enqueues a NEW delivery GENERATION for the SAME
    prompt — no new prompt, no fingerprint change, terminal items never
    reopened).
  - cancelled (delivery): prompt CANCELLED (terminal; only from open),
    member CANCELLED; callbacks answer "This prompt is no longer
    active."; the blocker follows the superseding state.
  - expired (Axis B; only from open): prompt EXPIRED, member EXPIRED;
    callbacks answer inactive; status notice: "The approval prompt
    expired. Resume the job to get a fresh one."; notified_fingerprint
    cleared; resume issues a NEW prompt row (the blocker is unchanged, so
    the fingerprint and thus the new prompt's identity slot are stable).
  Cards go inactive ONLY on terminal prompt lifecycle (cancelled /
  expired / superseded / settled) — never while a human decision would
  still be meaningful.
- DETERMINISTIC-ID CONSUMERS REPLACED: grant validation's setup-pause:
  prefix + encoded-fingerprint checks
  (setup-pause-permission-wiring.ts:175,237) and recovery's retire helper
  (job-permission-recovery.ts:149) move to persisted
  job_id/setup_fingerprint identity. (Generation sites
  setup-pause-permission-prompt.ts:164,267 and fixtures = decomposition.)
- ATOMIC PREPARATION: one composite op, one transaction: lock+revalidate
  job (exists, setup-paused, same fingerprint) -> insert interaction +
  prompt (immutable callback alias in providerAliases) + FULL outbound
  aggregate (delivery, final-answer row, item —
  outbound-delivery-repository.postgres.ts:47,91); same-app enforced in
  the op.
- DELETE/CANCEL: ONE transaction spanning job delete + prompt/interaction/
  delivery cancellation with structured reason (today delete-then-swallow,
  job-management-service.ts:318, canonical-job-repository.postgres.ts:304).
- ITEM SCHEMA: + permission_prompt_id (nullable, plain FK to prompts for
  existence) + generation + send_begun_at. Uniqueness composes with
  generations: (permission_prompt_id, generation) UNIQUE, plus a PARTIAL
  UNIQUE on permission_prompt_id WHERE the item is non-terminal — exactly
  one ACTIVE delivery per prompt, terminal history retained per
  generation. Parent delivery + item both gain cancelled + structured
  reason; derivation helpers updated
  (outbound-delivery-repository.postgres.helpers.ts:199,258).
- ONE composite S3 repository owns prepare / cancel / checkpoint
  (beginSend(itemId, claimToken), lease-fenced) / settle / reconcile.
- ONE-MESSAGE RENDER: bounded single-message card (summary + expandable,
  html-render.ts:95; hard budget; overflow -> "open the pending list");
  never the document/split paths (channel-prompts.ts:131,219);
  permission-card view added to MessageSendOptions (types.ts:532);
  canonicalText = summary (outbound-delivery-service.ts:372); dedicated
  profile registered (runtime-services.ts:719).
- DISPATCH: recovery loop -> getPermissionPrompt(promptId) (enforces
  appId/open/pending-member/fingerprint; worker-coordination.ts:350) ->
  REVALIDATE -> beginSend -> ONE provider send (alias pre-bound,
  channel-prompts.ts:211; durable callback resolves,
  channel-connect.ts:600, permission-callback.ts:71,75).
- LEASE: expired claim, send_begun_at NULL -> retryable (today
  unconditionally ambiguous,
  outbound-delivery-repository.postgres.claims.ts:43); set -> ambiguous
  (conservative window accepted). Reconciler scans ALL unreconciled
  terminal deliveries + periodic prompt-expiry scan (TTL 24h,
  ipc-interaction-lifetime.ts:4) on the shared tick; owns projection +
  job CAS + event append in one transaction. Expiry job-side mutation is
  a dedicated coordination op (action + notified_fingerprint + fingerprint
  recompute, one transaction).
- SETTLEMENT: extends existing receipt+item transaction
  (outbound-delivery-repository.postgres.ts:172) to attach the provider
  locator to the prompt row.
- TYPED RESULT PermissionApprovalResult: {kind:'decision', decision} |
  {kind:'delivery_failure', code: target_missing | surface_unsupported |
  provider_failed, retryable, delivered:'no'|'unknown', userMessage}.
  TRANSMISSION-BOUNDARY RULE (J11-5, pass-12 corrected): delivered:'no'
  ONLY for failures proven by a LOCAL preflight before any provider API
  method is invoked — target resolution/validation failures, disabled
  surface. ONCE the provider API call has been invoked, EVERY exception
  or timeout (including connection refused reported by that call) =
  delivered:'unknown' — the adapter cannot prove non-transmission. The checkpoint is the provider API call
  itself: telegram sendMessage (public path binds after send,
  prompt-binding.ts:88, permission-approval-delivery.ts:145,165); slack
  chat.postMessage (permission-approval-delivery.ts:194,250; outer
  wrapper channel-delivery.ts:568 cut over too); teams activity send
  (teams-permission-approval.ts:123,159); discord message create
  (discord-interactions.ts:198,237). delivered:'unknown' NEVER
  retryable. Consumers (complete): types.ts:647; ipc-domain-types.ts:71;
  ipc-interaction-handler.ts:19; ipc-capability-template-amendment.ts:240;
  ipc-skill-permission-review.ts:101,142; ipc-admin-handlers.ts:170;
  ipc-runtime-admin-handlers.ts:126,370;
  ipc-agent-profile-handlers.ts:276,338;
  ipc-skill-install-handlers.ts:216;
  ipc-permission-classifier-decision.ts:464;
  core-tool-permission-coordinator.ts:71 (absent surface ->
  target_missing); requester single+batch
  (permission-approval-requester.ts:145,321,460). Every caller branches
  explicitly — infra failure is never a human denial. Durable handler
  branches before afterDecision/settlement
  (durable-interaction-handler.ts:128,175,183); delivered prompts keep
  no-response-timeout (interaction-settlement.ts:101).
- Call sites: setup waiting call deleted
  (setup-pause-permission-wiring.ts:123); core tools -> retryable infra
  outcome + cleanup (core-tool-permission-coordinator.ts:41,71,
  permission-decision-coordinator.ts:30); inline MCP wait -> typed result
  + finally cleanup (inline-agent-loop-tools.ts:491,561-577). Promotion
  cleanup NARROWLY worded (pass 11): ONLY the unused offer lane is
  removed — offer wrappers (:397/:249), PermissionPromotionInput.offer
  (permission-promotion.ts:6), markOffered port surface
  (domain/ports/permission-promotion.ts:4), the lastOfferedAt column
  (schema.ts:45) and its pins
  (permission-promotion.postgres.integration.test.ts:24). The
  counter/read path (allowCount/createdAt/deniedAt,
  permission-classifier.ts:268,437) is UNTOUCHED.

## S4 — Host-compiled fix proposals + run guidance (depends: S2a AND S2b)

- Agent-authored amendment path REMOVED (capabilities.ts:96,331). ONE
  entry: the host recorder.
- HOST MISMATCH FLOW: the host handler (verified context,
  ipc-capability-run-handler.ts:54,117) invokes the compiler/proposal
  service DIRECTLY in the request path (compile -> record via host-only
  entry -> readiness produces the S2b fix_proposal blocker from the
  recorded proposal); the JOB_TOOL_DENIED event (host lane, idempotent) is
  appended as observability. A dedicated mismatch discriminant replaces
  the shared invalid_args code (structured-local-cli-invocation.ts:163,
  169 — exact plumbing decomposition).
- DURABLE INTENT (S4-P1/P2 resolved, closes D-0057): the approval intent
  row is inserted INSIDE the existing amendment repository transaction
  (capability-template-amendment-repository.postgres.ts:203) for BOTH
  amended and already_amended outcomes. SCOPE: app-wide capability
  (matches current recovery, ipc-capability-template-amendment.ts:331) —
  target set = all jobs paused on that capability at approval time;
  completion = every target resumed OR superseded (blocker changed, job
  deleted); retries on the shared recovery tick with backoff; deleted-job
  targets close; a newer approved amendment for the same capability
  supersedes the intent.
- COMPILER CONTRACT (S4-P3 resolved, inline): input = the verified
  observed argv + the app's catalog templates for the capability. Compile
  iff (a) EXACTLY ONE catalog template shares the literal
  executable+subcommand prefix (full pinned executable path,
  semantic-capabilities.ts:559), AND (b) the observed argv MATCHES that
  template's tokens — existing LITERAL tokens match exactly; existing
  PURE-WILDCARD (*) positions match any single non-flag argument (the
  existing matcher's rule, structured-local-cli-invocation.ts:199) —
  followed ONLY by additional trailing positional values and/or trailing
  flags; no interleaving, no reordering, no shorter-than-template argv.
  MIXED-GLOB templates (a token combining literal text with *, e.g.
  range-*, matched via globMatches :226 and accepted by the validator,
  semantic-capabilities.ts:536, pinned
  capability-template-widening.test.ts:97) are INELIGIBLE for compilation
  — any capability whose sole prefix-matching template contains a mixed
  glob falls to instruction (pass 13; conservative, keeps the compiler's
  authority synthesis simple).
  Output: the base template extended with one wildcard per trailing
  positional, PLUS (if flags observed) the flagged variant with each flag
  literal and its value wildcarded (--account <x> -> --account *). Both
  templates full pinned-path. The flagged variant classifies 'expanded'
  -> stronger warning (capability-template-widening.ts:44,94). ANY other
  shape (zero or multiple prefix matches, interleaved tokens, unknown
  executable) -> instruction action, no proposal. Reuses parseBashCommand
  + validateLocalCliCommandTemplate + the widening classifier; CAS/merge
  as verified (capability-template-amendment-repository.postgres.ts:220,
  274,382; ipc-capability-template-amendment.ts:304).
- Argv redaction here (--account <email>, NAME@host,
  capability-template-amendment.ts:27,79); canonical_key REAL data
  migration here (keep-newest, supersede via denied/system:superseded;
  current key contains argv, capability-template-amendment.ts:19).
- Run guidance block (gantry-agent-system-prompt.ts:261-266) + one
  snapshot test per runner. Creation-time grammar validation reuses the
  compiler validator (autonomous-jobs.md:144).

## S5 — Live ACCEPTANCE GATE (depends S2-S4; S5-P1 resolved — inline)

LIVE SEQUENCE (owner's Telegram, real job): trigger the job so it runs
`gog sheets get 12s6uzwLDLV-DVcTH6XBa5vV3FZJUo04fLm0npfgACb4 <range>
--account <the incident google account email>` -> host records the typed
mismatch (capability_template_mismatch, host lane) -> fix-proposal card
WITH Approve/Deny BUTTONS arrives in the owner's chat -> owner taps
Approve -> amendment applies BOTH templates (`<pinned>/gog sheets get * *`
and `<pinned>/gog sheets get * * --account *`) -> durable intent resumes
the job -> post-grant repeat of the same argv is ALLOWED (0121) -> the
rerun writes leads to the sheet -> a repeat readiness evaluation raises NO
duplicate card.
FAULT MATRIX (split around the checkpoint): kill the runtime (1) between
preparation and dispatch -> card arrives after restart, exactly once; (2)
after beginSend before/around provider send -> conservative ambiguity:
owner gets the ambiguous status notice + pending list, no duplicate card;
if a card DID arrive it REMAINS ACTIVE and a tap on it resolves the
decision (consistent with J11-4 — only cards from PRIOR terminal prompts
answer inactive); (3) during reconciliation -> projection self-heals
idempotently, no duplicate terminal event.
FINAL STEP: the KnackLabs prompt sweep to business-only — executed only
after the owner approves the specific new prompt text in chat.

## Decomposition ledger (NOT plan blockers; carried into task contracts)

- S2a-D1 producer conversion inventory (deep-agent-runner.ts:234,
  tool-permission-gate.ts:538 JOB_TOOL_ACTIVITY -> JOB_TOOL_DENIED; plus
  the scheduled-run REMOVED_NATIVE_SUBAGENT_TOOL denial,
  tool-permission-gate.ts:150 — pass-15 note; behavior already decided by
  the only-three-exclusions rule).
- S2a-D2 done in-plan (helper retained). S2a-D3 denial pins:
  execution-diagnostics.test.ts:9; execution.test.ts:586;
  job-lifecycle.postgres.integration.test.ts:1047;
  deepagents-terminal-denial-turn.test.ts:253;
  anthropic-autonomous-permission-recovery.test.ts:25.
- S3-D1 deterministic-ID generation sites + fixtures
  (setup-pause-permission-prompt.ts:164,267;
  setup-pause-prompt.test.ts:631,753;
  job-permission-recovery.test.ts:1016). S3-D2 scheduler sync, live-map
  cleanup, lock order, repository method names. S3-D3 full fixture sweep.
- S4-D1 mismatch discriminant plumbing. S4-D2 amendment recovery as its
  own service on the shared tick. S4-D3 agent-path removal test sweep
  (ipc-mcp-stdio.test.ts:1530ff; ipc-admin-handlers.test.ts:2141ff).
- Cumulative replaced-pins list from passes 5-10 (setup-pause-prompt
  1908-2466 families; job-management-create 110; outbound recovery 379;
  outbound integration 782; outbound repo 125; requester 216; four channel
  tests; status-formatting 179; execution-notifications 436;
  autonomous-tool-denial 17; capability-template-widening 159;
  execution-finalization 56; job-visibility-metadata 168) — mechanically
  re-enumerated per story at decomposition.
- Generated OpenAPI/SDK/CLI contract-test enumeration.

## Deferred: MEM-1; guidance diet;
JobPrimingService cleanup.

## Procedural note (not for validation): after validation this plan enters
the factory (in-repo approved plan, grill, sign-off, decomposition,
WORKFLOW.md:381).

## Validation questions for pass 15 (confirmation pass)
1. The generation-aware outbound aggregate identity
   (`setup_permission_prompt:<promptId>:<generation>` on
   (app_id, idempotency_key); generation allocated under the prompt lock
   in the enqueue transaction; same-generation replay returns the same
   aggregate): correct and complete against the schema/repository code,
   file:line?
2. Any remaining PLAN-level gap ANYWHERE in the plan — after fourteen
   passes, sweep once more with fresh eyes. Do not inflate decomposition
   detail into plan blockers.
3. Final per-story verdict (S1, S2a, S2b, S3, S4, S5): is each story
   ready for the factory pipeline (S1 authored first, then decomposition
   authoring exact task contracts per WORKFLOW.md:281)?
