# C+D Durable-Interaction Envelope: Persistence-Safety Fix

Second consolidation of the durable permission/question envelope. Round-46
autoreview + an independent Fable review converged on eight defects in the
recovery envelope and durable-question workflow. They share one root: **the
envelope's persistence is not safe** — it persists unsanitized input, mutates
the row with non-atomic read-modify-replace, fails to persist live UI state at
the callback boundary, mishandles post-send persistence failure, and leaves
stale batch markers / settled batch claims on individually re-bound rows.

Scope after #228 closeout: PERMISSION recovery remains fully durable. QUESTION
interactions are in-process only; pending rows exist only for live callback
routing, provider settlement, audit, and fail-closed persistence. A restart
terminalizes an orphaned question row and the runner re-asks; no question
envelope replay or answer recovery is in scope.

Fix the MUST-FIX invariants below across all four providers (Telegram, Discord,
Slack, Teams) with a call-site audit + tests. **Escalate, do not expand:** if an
invariant needs more than atomic writes at the existing callback boundary — new
schema, migration, or cross-process coordination — STOP and emit
`DECISION NEEDED:` with the specifics instead of building it. The orchestrator
(Claude) is watching your job log and will answer contradictions/scope calls.

## Invariants

### I1 — Sanitization boundary (SECURITY, must-fix)

`bindPendingPermissionInteractionMessage` (pending-interaction-prompt-binding.ts
~149) writes the live request object into `pending_interactions`. The initial
durable snapshot already strips `toolInput`; the recovery envelope must persist
the **same sanitized/rendered snapshot**, never the raw request (commands, file
contents, credentials). Persist the provider-rendering model + sanitization
metadata already computed — not the live `request`. Verify with a test that
asserts no raw command/file/credential string reaches the persisted payload.

### I2 — Atomic envelope updates (concurrency, must-fix)

Every read-modify-write on the `pending_interactions` payload (bind, delivery
index, answer-progress, recovered-callback bind, selection toggle, timeout /
completion) currently reads the whole payload and replaces it with a stale
snapshot. Concurrent writers (delivery vs. later callback bind vs. answer
progress) lose siblings — callbacks, selections, completedIndexes, answers,
deliveryIndex. Replace with an **atomic path-level JSONB merge or CAS** (row
lock / version check) at the repository boundary. One shared update path; no
whole-payload replace.

### I3 — Persist live UI state at the callback boundary (completeness, must-fix

IF achievable via atomic write; else escalate)

- Multi-select toggles mutate only the in-process set (slack/user-question-
  interactions.ts ~122; Telegram/Discord same). Persist each toggle into the
  durable `selections` before ack/refresh, so a recovered prompt's Done resolves
  the real selection, not empty.
- Delivered-then-timed-out questions skip the progress write (slack/user-
  question-delivery.ts ~155; Telegram/Teams/Discord same). Persist the completed
  index (with the timeout result) BEFORE the live loop continues.
  If either needs schema beyond the existing `selections`/`completedQuestionIndexes`
  payload fields, escalate instead of migrating.

### I4 — Fail-closed on post-send persistence failure (must-fix)

When the provider send succeeds but `recordDurableQuestionPromptDelivered` (or
the permission equivalent) fails (discord-user-question-delivery.ts ~125 and
siblings), do NOT return a normal empty response — that resolves the IPC with no
answers and silently skips the question while a live prompt is still visible.
Propagate the failure or keep the row pending/retryable and terminalize+recover
the visible prompt. Never convert a persistence failure into a successful empty
answer.

### I5 — Claim / batch-marker lifecycle on re-bind (must-fix)

- **Clear stale batch markers on individual re-bind.** `bindPending…Message`
  only writes `permissionBatchCallbackId`/`permissionBatchRequestIds` when
  `requestIds.length > 1`, and the row merge is "existing wins"
  (worker-coordination-interaction.postgres.ts ~442), so a row that was once in
  a batch keeps those markers after being re-prompted individually. Its
  individual claim then fails the CAS guard `NOT (payload ? 'permissionBatch
CallbackId')` (~344) → zero rows. An individual re-bind must **explicitly
  clear** the batch markers so the row shape matches its individual envelope;
  the merge must honor explicit clears, not silently keep the old value.
- **Don't replay a settled batch claim against a re-bound individual member.**
  `replayPersistedPermissionDecisionForRequest` picks `claim = persistedClaim ??
settledClaim` (pending-interaction-permission-callback.ts ~74); after a batch
  "Review each" settles and members are re-bound individually, the settled batch
  claim is replayed against an individual envelope and throws
  ('Persisted review-each claim has no review-each phase', ~108) → the IPC catch
  denies the runner while the live prompt is still active → dangling transient
  grant. When the settled claim's kind doesn't match the row's current envelope
  kind, return **null** (still pending — let the live prompt settle), never
  throw→deny.
- **`already_decided` with no holder must not hang.** A zero-row CAS result maps
  to `{status:'already_decided'}` (~410); all four providers' timeout handlers
  early-return on `already_decided` WITHOUT resolving the in-memory prompt
  (slack/channel-interactions.ts ~137,160; discord-interactions.ts ~446,467;
  telegram/permission-approval-delivery.ts ~104,122; teams-permission-
  approval.ts ~78,94), assuming another claimant will settle. When no claim is
  actually held, the permission IPC blocks forever. Distinguish "already settled
  by a real holder" from "zero-row because the row shape is stale": the latter
  must fail closed to a **deny/resolve**, never an indefinite hang. (Fixing I5.1
  removes the stale-shape cause; still make the no-holder path resolve, not
  hang, as defense in depth.)

## Verification

- Unit + restart-replay tests per provider: individual-after-batch permission
  recovery (I5.1), review-each-after-batch replay returns pending not deny
  (I5.2), already_decided-no-holder resolves not hangs (I5.3), multi-select
  toggle persisted across restart (I3), timeout-complete persisted (I3),
  post-send-failure keeps retryable (I4), concurrent envelope writers don't
  clobber siblings (I2), sanitized snapshot carries no raw input (I1).
- `tsc --noEmit`, focused channels/application/runtime suites, arch gate.
- Ponytail: smallest diff that upholds each invariant; extract a shared atomic
  update path rather than repeating CAS logic in each provider.

## Implementation ledger

- Reused `durablePermissionRequestSnapshot` for the initial permission row,
  rendered recovery request, and every recovery member request. The helper was
  moved to the shared permission-envelope module; no second sanitizer or
  provider-specific redaction path was introduced.
- Replaced whole-payload writes and the permission-only merge with one
  `updatePendingInteractionPayload` repository operation. Its synchronous
  updater runs inside a Postgres transaction after `SELECT ... FOR UPDATE`, so
  every binding, delivery, answer, selection, and completion write derives from
  the row version holding the lock.
- Existing question-envelope fields were sufficient for I3; no schema,
  migration, or cross-process coordination was needed. Live selection toggles
  persist through `selections` before local mutation/acknowledgement, while a
  timeout writes the provider's empty result plus
  `completedQuestionIndexes`.
- A typed `DurableInteractionPersistenceError` distinguishes repository/write
  failures from legitimate false results caused by a settled or missing row.
  Provider delivery boundaries propagate the typed post-send failure; live
  permission waiters remain registered for their bounded timeout/recovery path.
- An individual permission re-bind explicitly removes both stale batch-marker
  fields. A settled claim whose batch/individual kind disagrees with the current
  envelope is ignored as still pending, and a zero-row claim is considered
  already decided only when a real holder, matching terminal settlement, or no
  pending row exists. A matching pending row without a holder stays retryable,
  so each provider's bounded timeout path eventually resolves a deny.
- The architecture gate's line budgets were restored by moving question
  recovery parsing, interaction resolution, Discord interaction formatting and
  acknowledgement, and Teams SDK-client construction into narrowly owned
  sibling modules. No budget or ownership-map allowance was changed.

---

# Round 2: single-winner + fail-closed consolidation

Round-47 autoreview + a Fable re-review of the envelope fix found the original
eight defects fixed, but exposed a new cluster of single-winner and fail-closed
races (verdict "incorrect 0.99"). Fix the TWO structural invariants once at the
shared gate, plus three localized bugs, with a per-provider call-site audit +
tests. Same discipline as above: ponytail-smallest diff, no new abstractions,
escalate (`DECISION NEEDED:`) if an invariant needs schema/coordination beyond
the existing claim CAS. The orchestrator is watching this job log.

## SW — Single-winner atomicity (structural, must-fix)

The claim CAS in `resolvePendingInteraction` is the ONLY gate that may publish a
terminal outcome. No path (live callback, disconnect cleanup, timeout, batch
fan-out) may append a live-turn command/outbox row, resolve an in-memory waiter
as denied/cancelled, or terminalize the row unless it is the CAS winner.

- **SW.1 — publish only after winning the CAS.** `pending-interaction-
resolution.ts:84` appends the live-turn command BEFORE `resolvePendingInter
action`'s claim-scoped CAS. If the CAS loses (e.g. a disconnect/timeout cancel
  races an already-claimed user decision), the losing payload is already durably
  queued and, sharing the interaction's idempotency key, is replayed in place of
  the real winner's command. Make the row transition and the outbox/command
  insertion ONE atomic winning operation (insert inside the same tx, only when
  the CAS updates a row), or have consumers validate the committed resolution
  before applying the command.
- **SW.2 — disconnect must not overwrite an in-flight winner.** Discord
  disconnect cleanup (`discord-interactions.ts:371`) unconditionally resolves
  every remaining waiter as denied, ignoring whether `settlePermissionPrompt`
  returned `already_decided` — which can mean an authorized callback already owns
  the durable claim and is still terminalizing its provider prompt. Disconnect
  then discards the real winner's decision. Branch on the settlement result;
  preserve an `already_decided` waiter for its owner. Teams, Telegram, and Slack
  disconnect cleanup have the same pattern — fix all four.

## FC — Fail-closed propagation (structural, must-fix)

`DurableInteractionPersistenceError` (a post-send durable-write failure while the
prompt is still visible and the live waiter retained) must propagate to a
WITHHELD/retryable outcome at EVERY boundary — never be converted to an empty
answer or a denial.

- **FC.1 — question IPC catch.** `ipc-interaction-processing.ts` ~821 (and the
  sibling at `ipc.ts:745`) currently routes the typed error into
  `writeUserQuestionInteractionFailure`, which writes a normal `{answers:{}}`
  response — indistinguishable from a real no-answer. Special-case the typed
  error: withhold/leave the row pending for restart replay; do NOT write empty
  answers.
- **FC.2 — permission requester/coalescer.** `permission-approval-requester.ts:
167` converts the typed error into an ordinary denial (and the batch fan-out
  then resolves scheduled requests as denied too), so IPC terminalizes the row
  while an actionable prompt is still visible and the retained waiter is orphaned.
  Propagate the typed failure through the requester/coalescer (reject the
  per-request promise); never manufacture a permission decision from it.

## Localized fixes

- **L1 — Discord live authorization uses the wrong conversation (security).**
  `discord-permission-callback.ts:64` omits `conversationJid`, so
  `isInteractionApproverAllowed` defaults to `dc:${interaction.channel_id}`
  instead of the request's `approvalContextJid`. For a prompt shown in a thread
  or a different conversation, this checks the wrong approver list. Pass
  `pending.request.approvalContextJid ?? pending.request.targetJid` here and in
  the live full-view check. (Recovered path + other providers already do this.)
- **L2 — preserve partial answers on timeout.** `discord-user-question-
delivery.ts:80` (and the Teams bulk-timeout at `teams.ts` ~508) resolves with
  `answers: {}` when a later question times out, dropping the user's earlier
  answers. Resolve with `pending.answers` merged with the just-persisted timeout
  values. Also add an already-completed guard in `recordDurableQuestionAnswer
Progress` (`pending-interaction-durability.ts` ~401) so a timeout write can't
  clobber a concurrently-recovered real answer.
- **L3 — restore the sanitizer whitelist (I1 security).** `durablePermission
RequestSnapshot` (`pending-interaction-permission-envelope.ts:17`) was rewritten
  from a ~13-field whitelist to `{...request}` minus `toolInput` (a blacklist),
  so runner-supplied `description`/`interaction.files`/etc. now reach the durable
  payload. Restore an explicit allowlist of the rendering fields actually needed;
  the I1 test must assert those specific risky fields are absent, not just
  `toolInput`.

## Verification

- Per-invariant tests: SW.1 losing-CAS does not queue/replay a command; SW.2
  disconnect preserves an `already_decided` winner (all four providers); FC.1
  question persistence failure leaves the row pending, not empty-answered; FC.2
  permission persistence failure rejects the request, does not deny/terminalize;
  L1 threaded-prompt authorizes against approvalContextJid; L2 timeout keeps
  earlier answers; L3 snapshot omits the whitelisted-out fields.
- `tsc --noEmit`, channels/application/runtime suites, arch gate.

## Round 2 implementation ledger

- SW.1 uses the existing Postgres interaction-resolution CAS as the single
  publication gate. The optional `interaction_resolved` live-turn command is
  inserted in the same transaction only after the CAS updates a pending row;
  a losing CAS inserts nothing, and an inactive live turn rolls the row update
  back. No consumer-side validation or second command path was added.
- SW.2 treats `already_decided` as an owned in-flight result on disconnect in
  Discord, Slack, Telegram, and Teams. Those waiters remain registered for the
  claim owner; `retryable` still takes the existing local cancel fallback, and
  `settled` has already removed its waiter.
- FC.1 withholds permission and question IPC responses when
  `DurableInteractionPersistenceError` reaches either processing catch. The
  claimed input is archived for recovery while the durable interaction remains
  pending; no empty answer or denial response is written. The existing IPC
  fallback writers were moved unchanged to a narrowly owned sibling to keep
  both runtime files within their existing line budgets.
- FC.2 rethrows the typed persistence error at the approval surface and rejects
  every still-pending coalesced request with that same error. Ordinary routing
  and provider failures retain their existing fail-closed denial behavior.
- L1 passes `approvalContextJid ?? targetJid` to both live Discord authorization
  checks, matching the already-correct recovered callback path.
- L2 merges Discord's retained local answers with only the newly timed-out
  answers. Teams returns its timeout-answer map; its already-persisted earlier
  answers continue to merge at the question IPC recovery boundary. Atomic
  answer progress ignores input for indexes already marked complete, so a
  timeout cannot overwrite a concurrently committed real answer.
- L3 restores an explicit durable permission-request allowlist. It retains only
  routing, rendering-choice, sanitization metadata, semantic capability, and
  batch fields; raw `toolInput`, `description`, and `interaction` content are
  excluded.
- No schema, migration, or new cross-process coordination was required, so no
  `DECISION NEEDED:` item was raised.

### Surface Impact Matrix

| Surface                      | Classification      | Reason                                                                                             |
| ---------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed             | One CAS publishes terminal outcomes; typed persistence failures remain retryable.                  |
| `settings.yaml`              | Unchanged by design | No desired-state value or setting is introduced.                                                   |
| Postgres/runtime projection  | Changed             | Existing interaction and live-turn-command rows are written atomically with no schema change.      |
| Control API                  | Unchanged by design | No public administration contract changes.                                                         |
| SDK/contracts                | Changed             | The internal pending-interaction repository accepts an optional live-turn command.                 |
| CLI                          | Unchanged by design | No local operator workflow changes.                                                                |
| Gantry MCP tools/admin skill | Unchanged by design | No agent-facing or admin tool changes.                                                             |
| Channel/provider adapters    | Changed             | All four disconnect paths preserve an in-flight winner; Discord and Teams receive localized fixes. |
| Docs/prompts                 | Changed             | This ledger records the Round 2 decisions and scope.                                               |
| Audit/events                 | Changed             | Typed persistence failures no longer emit false successful/denied terminal outcomes.               |
| Tests/verification           | Changed             | Added per-invariant and four-provider regression coverage.                                         |

---

# Round 3: converging tail (orphaned-waiter + callback latency)

Round-48 autoreview + Fable re-review confirmed the two structural classes
(single-winner, fail-closed) are ELIMINATED — no relocation, no design rethink.
Four remaining items, all bounded. Same discipline: ponytail-smallest diff, fix
the orphaned-waiter root ONCE at the shared typed-error/withhold boundary and
audit every provider, escalate (`DECISION NEEDED:`) only if a fix needs
schema/coordination. Orchestrator watching the job log.

## R3.1 — Drop the in-memory waiter on typed-error withhold (moderate, must-fix)

After a post-send `DurableInteractionPersistenceError`, IPC correctly withholds
(archives, leaves the row pending) BUT the live in-memory waiter (promise +
timer + callback maps), registered before the failed persist, is deliberately
RETAINED. If the DB recovers and the user then clicks Allow/answers, the live
in-memory path claims the row, edits the prompt to an "Allowed"/answered receipt,
and resolves a promise nobody holds — the grant is never applied, the row never
terminalizes (claim lingers to the 24h TTL), no IPC response is written, and the
runner watchdog denies. UI shows success; decision is dropped; the retained
waiter SHADOWS the recovered/durable path that would have resolved it correctly.

- Applies to BOTH permission and question paths, ALL four providers
  (round-48 flagged Telegram `channel-delivery.ts:656` + Teams `teams.ts:569`;
  Fable generalizes to Discord/Slack bind catches + the question timeout-persist
  rejections).
- Fix: on the typed-error withhold, CLEAR the in-memory live state (promise,
  timer, pending-callback maps) before/at propagation, so a subsequent click
  routes through the recovered/durable path (which terminalizes + delivers the
  in-CAS live-turn command). Do this once at the shared boundary where the typed
  error is raised/caught per lane, not per-provider ad hoc. Do NOT reintroduce
  any empty-answer/denial conversion (FC stays closed).

## R3.2 — Acknowledge provider callback before awaiting later questions (P2)

`recordDurableQuestionAnswerProgress`/recovery dispatch: when a recovered answer
advances to another question (`pending-interaction-durability.ts:570`), it awaits
the full recovery dispatcher (which awaits the entire `requestUserAnswer` flow),
so the CURRENT callback stays pending until all later questions resolve/timeout —
Telegram's `answerCallbackQuery` isn't sent, the spinner expires though the
answer was stored. Fix: persist the current answer and ACK the provider callback
first, then schedule the continuation independently (fire-and-forget the next
prompt), so provider ack is timely.

## R3.3 — Disconnect preserves partial question answers (low, pre-existing)

L2 fixed timeouts but disconnect still drops mid-flow answers: Discord
`clearPendingInteractions` and Telegram `disconnect.ts:72-79` resolve questions
with `answers: {}` / empty selections, and `finishDurableQuestionInteraction`
writes the channel response rather than the richer durable envelope. Resolve from
the durable envelope (`pending.answers`) on disconnect, mirroring the L2 timeout
fix. Cheap; same family.

## R3.4 — Resolve the local waiter on ownerless already_decided (low, defense)

If the claim gate returns `already_decided` because the row is GONE (TTL-expired
/ externally cancelled) rather than claimed, timeout/disconnect paths return
without resolving the local waiter, hanging the map entry + requester promise for
the process lifetime (`discord-interactions.ts:431,452` + siblings). Unreachable
in normal timing (10-min prompt vs 24h TTL) but resolve the local waiter (deny)
on ownerless already_decided as defense-in-depth.

## Verification

- Tests: R3.1 post-persist-failure then user-click → durable path terminalizes +
  grants (no orphaned-promise drop), all four providers, permission + question;
  R3.2 provider callback acked before later prompts; R3.3 disconnect keeps partial
  answers; R3.4 ownerless already_decided resolves the waiter.
- `tsc --noEmit`, channels/application/runtime suites, arch gate. FC/SW invariants
  stay green (do not regress the round-1/2 tests).

## Round 3 implementation ledger

- R3.1 adds one optional live-waiter cleanup hook to the channel interaction
  surface and invokes it only at the shared typed-error boundary for each lane:
  `permission-approval-requester.ts` for permissions and
  `channel-wiring-interactions.ts` for questions. Discord, Slack, Telegram, and
  Teams clear matching promise, timer, and callback-map state without resolving
  it, so the recovered durable path wins and fail-closed behavior stays closed.
- R3.2's recovery continuation was removed by the #228 split-out below. The
  live in-process question loop persists each answer before continuing; no
  callback schedules later durable work.
- R3.3 resolves Discord disconnects with the pending durable answer envelope and
  Telegram disconnects with the pending multi-select answers, preserving partial
  question progress in the same way as the Round 2 timeout fix.
- R3.4 distinguishes an ownerless `already_decided` result when the durable row
  is gone. Timeout and disconnect paths deny and resolve only that local waiter;
  an owned in-flight winner remains registered and unchanged.
- The Round 3 closeout scopes that ownerless result to the internal `system`
  cancellation used by timeout/disconnect cleanup. User callback replays after
  a released retry or completed settlement now receive plain `already_decided`,
  preserving the Round 1/2 release-and-retry and same-claim invariants. The
  classifier's opt-in lookup also includes a matching terminal settlement, so a
  committed owner cannot be mistaken for a gone row. Slack's waiter-drop
  coverage registers both live maps with an authorized approver and observes
  the permission and question promises independently, proving cleanup removes
  neither by resolution.

## #228 closeout ledger

- Durable QUESTION recovery is deferred entirely to the durable-work-primitive
  cycle. Questions are in-process only: the live `requestUserAnswer` loop owns
  sequential dispatch and answer collection while the process is running. On
  restart, an orphaned pending QUESTION row is terminalized fail-closed and the
  runner re-asks; no question envelope replay, answer recovery,
  partial-cancellation reconciliation, or cross-restart finalization remains.
  PERMISSION recovery remains fully durable and unchanged, including claim
  CAS/single-winner, fail-closed recovery envelopes, batch coalescing,
  disconnect winner preservation, permission-approval-requester, and all four
  provider paths.
- The durable QUESTION row remains only for live callback routing, provider
  settlement, audit, and fail-closed prompt/answer persistence while the
  process is up. Duplicate question labels are still rejected before
  persistence, and a current-question post-send persistence failure still
  withholds the response so the runner re-asks.
- Surface impact: runtime question recovery behavior, question-only provider
  fallback handlers, tests, and this ledger changed. Postgres schema,
  `settings.yaml`, Postgres/runtime projection, control API, SDK/contracts,
  CLI, Gantry MCP/admin tools, provider permission paths, and audit/event
  contracts are unchanged by design because this closeout removes internal
  question restart coordination without changing public or configuration
  surfaces.
