---
story: LIVE-1
status: awaiting-approval
decisions_reviewed:
  - 0000-credential-broker-boundary
  - 0001-agent-runtime-platform
  - 0002-symphony-forge-adoption
  - 0003-early-stage-no-backcompat
  - 0004-gantry-naming-and-public-repo
  - 0005-runtime-stack
  - 0006-config-secret-source-boundary
  - 0007-settings-runtime-truth
  - 0008-storage-backend-cutover
  - 0009-canonical-domain-schema-cutover
  - 0010-claude-runtime-materialization
  - 0011-provider-session-artifact-store
  - 0012-browser-capability-boundary
  - 0013-runtime-event-exchange
  - 0014-external-ingress-vs-outbound-webhooks
  - 0015-model-catalog-and-cache-accounting
  - 0016-event-bus-outbox-boundary
  - 0017-jsonb-runtime-payload-boundary
  - 0018-provider-neutral-agent-execution-adapter
  - 0019-simple-permission-and-job-tool-lifecycle
  - 0020-mcp-source-vs-action-capability
  - 0021-capability-artifacts
  - 0022-delivery-vehicle
  - 0023-deployment-modes
  - 0024-locked-preset
  - 0025-settings-authority
  - 0027-process-roles-and-multi-live
  - 0028-agent-harness-selection
  - 0029-agent-communication-reaction-binding
  - 0030-agent-communication-reasoning-safety
  - 0031-send-message-files-authority
  - 0032-signed-artifact-links-deferred
  - 0033-teams-reactions-deferred
  - 0034-client-signoff
  - 0035-epics-approved
  - 0040-permission-execution-two-axis-model
  - 0041-client-signoff
  - 0042-decision-view-16k-prefix-stripped
  - 0043-classifier-risk-only-engine-authz
  - 0044-ci-runner-isolation
  - 0045-inbound-attachment-descriptor-writer
  - 0046-llm-process-local-admission
  - 0050-agent-removal-projection-cleanup
  - 0051-client-signoff
  - 0052-birthright-self-surface
  - 0053-permission-no-timeout-interactive
  - 0054-decision-provenance-and-risk-label
  - 0055-client-signoff
  - 0056-durable-cancellation-invariant
  - 0057-arch1-client-signoff
  - 0058-readonly-scheduler-birthright
  - 0062-perm6-client-signoff
  - 0063-perm7-client-signoff
  - 0064-client-signoff
  - 0065-perm8-client-signoff
  - 0066-race-1-skill-artifact-app-isolation
  - 0067-client-signoff
  - 0068-race-2-cluster-fenced-settings-projection
  - 0069-client-signoff
  - 0070-client-signoff
  - 0071-race-4-browser-profile-lock-aba
  - 0072-client-signoff
  - 0073-race-6-profile-mirror-version-guard
  - 0074-race-8-mandatory-atomic-async-admission
  - 0075-race-9-serialize-file-backed-settings-write
  - 0076-client-signoff
  - 0077-race-5-lease-loss-lifecycle
  - 0078-lat-3a-single-memory-hydration-per-turn
  - 0079-client-signoff
  - 0080-lat-3b-retain-authoritative-second-fetch
  - 0081-client-signoff
  - 0082-fence-1-durable-lease-generation
  - 0083-conv-001-client-signoff
  - 0084-client-signoff
  - 0085-lat-4a-fused-inbound-envelope-transaction
  - 0086-client-signoff
  - 0087-lat-5-durable-provider-history-coverage
  - 0088-client-signoff
  - 0089-thread-turns-read-channel-context
  - 0090-sender-allowlist-trigger-only
  - 0091-client-signoff
  - 0092-client-signoff
  - 0093-client-signoff-is-a-pinned-project-gate
  - 0094-conversation-file-trust-program
  - 0095-client-signoff
  - 0096-thread-recency-message-timestamp
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0100-mig-1-client-signoff
---

# LIVE-1 — Ambient Liveness Plan (Part B)

## Goal (plain language)

While the agent works, the chat shows honest ambient signals without one
extra message: a stalled run flips its existing progress card to "Still
working" and stops the lying typing indicator; Discord finally shows
typing; a slow start flips the seen reaction to an hourglass and back; a
message sent mid-run gets a seen reaction instead of looking lost; retries
edit the card they already own instead of spawning confusion.

## Premise (verified on this worktree, main a67215756 — corrects the doc)

- PART C IS SHIPPED: all six dead-plumbing deletions landed in PR #235
  (commit ba5e73088, 2026-07-20). This phase is Part B only and marks the
  doc's Part C done.
- The heartbeat file no longer has the "ignored inputs" the doc describes —
  they were deleted WITH Part C. Reviving the heartbeat means ADDING a
  stall detector: no lastOutputAt exists anywhere; the seam to set it is
  handleAgentOutput (group-processing.ts:560-590, at :577/:582); the 4s
  typing interval is group-progress-heartbeats.ts:134-147 gated by
  isTypingActive.
- replaceOnly progress edits exist (buildProgressOptions with
  replaceOnly:true is used twice already); every provider drops a
  replaceOnly without an existing card handle — the exact no-new-message
  behavior we need.
- TypingSink implementations today: Telegram + in-app only. Slack is
  truthfully sink-less (pinned by slack.test.ts:774 — keep). Discord has
  postJson ready; setTyping is ~4 lines. Teams' SDK client is a null stub
  with no typing/reaction surface — deferred.
- Reactions: seen/running maps exist on Slack/Telegram/Discord; NO caller
  ever sends 'running'; NO removeReaction exists in any adapter; dedupe
  sets are add-only. The flip therefore includes the first removeReaction
  trio (Slack reactions.remove, Telegram setMessageReaction empty-list,
  Discord DELETE .../@me) and per-emoji dedupe key removal on clear.
- Mid-run pokes and deferrals share ONE seam: message-loop.ts:402-435 —
  queue.sendMessage's true/false return; initialBatch's last
  external_message_id is the reaction ref; MessageLoopDeps needs an
  addReaction (channelWiring.addReaction is in scope at the construct site
  runtime-services.ts:1116-1132).
- Retry: 'I hit an issue.' maps in progress-updates.ts:28-35 under
  done:true, which DELETES the card handle on every provider — so retryable
  failures must send replaceOnly (keeping the handle and the generation)
  and only the final failure sends done. retryCount lives only in
  group-queue (state.retryCount, cap policy.maxRetries at :590-611),
  surfaced today as boolean finalRetry through 4 hops.

## In scope

1. **Stall heartbeat (3 min, user-locked).** Track lastOutputAt in
   group-processing (set on visible output); the existing 4s interval
   checks it — stalled means skip setTyping AND once per stall send
   sendProgressToChannel with 'Still working' and replaceOnly:true; output
   resets the stall latch and resumes typing. No elapsed text, no new
   messages (no-handle drop preserved).
2. **Discord TypingSink.** setTyping via postJson to /channels/{id}/typing
   with the addReaction channel resolution; wired by the existing
   capability sniff. Slack stays sink-less.
3. **Seen-to-running flip.** After the seen reaction, if no first visible
   output within ~5s: remove seen + add running; on first output: remove
   running + re-add seen. New removeReaction on Slack/Telegram/Discord
   adapters (existing HTTP helpers); dedupe keys deleted on removal so
   re-adding works. Hook threads through the existing onFirstProgress
   plumbing (live-execution.ts:318, group-processing-types.ts:73) as an
   emoji-carrying variant.
4. **Continuation receipts.** MessageLoopDeps.addReaction; at the
   queue.sendMessage seam both outcomes ack seen on the batch's last
   external message id.
5. **Retry on the same card.** Retryable failure edits the card replaceOnly
   with 'retrying n/max' (the doc-sanctioned exception), keeping handle and
   generation; final failure sends the existing done 'I hit an issue.'.
   Thread retryCount/maxRetries alongside finalRetry through the 4 existing
   hops.
6. **Docs truth.** Goal-prompt doc: Part C marked done (#235 citation),
   Part B marked shipped with this phase, program-ledger Part B row
   updated; Teams deferral recorded (typing + reactions on the real-client
   trigger shared with D-0034).

## Out of scope

Teams typing/reactions (null-stub client); any new status text beyond the
sanctioned retry counter; per-provider edit throttles, admission queue,
streaming sanitizer, card maps (audit-cleared, untouchable); Part D model-
client items (separate audit's territory).

## Surface Impact

- **Runtime behavior**: Changed — stall card edit, typing gating, reaction
  flips, continuation acks, retry card semantics.
- **API (control/SDK/contracts)**: Unchanged by design — TypingSink/
  reaction ports exist; only implementations and one dep field are added.
- **Data/schema**: N-A — no storage surface at all.
- **CLI/ops**: Unchanged by design.
- **UI**: N-A (channel surfaces are the UI; ambient only).
- **Docs**: Changed — goal-prompt Part B/C truth, ledger row, deferral.
- **Tests**: Changed — fake-timer heartbeat suites, wiring dispatch tests,
  adapter reaction/typing tests, message-loop dep, retry threading suites.

## Stages

- **LIVE-1-1 — everything (single stage).** Write scope:
  apps/core/src/runtime/, apps/core/src/channels/,
  apps/core/src/app/bootstrap/, apps/core/test/, docs/. Falsifiers (fake
  timers): 179s of silence means no card edit + typing continues; 181s
  means exactly one 'Still working' replaceOnly edit + setTyping stops;
  output after stall resumes typing and re-arms the stall; no card handle
  means the edit is dropped, never a new message; Discord setTyping posts
  to the typing route (and not when isTyping false); flip: 5s without
  output removes seen + adds running, first output removes running +
  re-adds seen (dedupe allows the re-add; drop the removal and the test
  fails); accepted AND rejected continuations both ack seen at the loop
  seam; retryable failure keeps the card handle and edits 'retrying 1/3'
  (drop the replaceOnly switch and the handle-deleted test fails), final
  failure sends done 'I hit an issue.'; slack.test.ts:774 sink-less pin
  stays green. Then closeout: verify.py, ONE 3-lens branch autoreview,
  artifacts, pr_ready.

## Verification bar

Unit suites with fake timers (no Postgres surface — first phase in the
program without a DB lane; verify.py full lanes still run). Reversible
negative controls per falsifier. Explicit what-did-not-improve: Teams
stays signal-less; Slack has no typing by design; wall-clock UX not
measured, behavior is the contract.

## Risks

- The 125s-advance heartbeat test asserts typing continues without host
  progress — compatible with a 180s threshold but the suite's fake-timer
  arithmetic is dense; extend, don't rewrite.
- Reaction flip on providers with rate limits: one extra add+remove pair
  per slow spawn is within existing reaction budgets; dedupe key removal
  must be scoped to the exact emoji.
- Retry card generation rollover: a retry that starts a new turn bumps
  progressGeneration — the retrying edit must ride the FAILING turn's
  generation before rollover (seam pinned in the falsifier).
