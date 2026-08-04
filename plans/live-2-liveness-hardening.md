---
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
  - 0099-rate-limits-singleton-authority
  - 0100-mig-1-client-signoff
  - 0101-oidc-generic-google-first
  - 0102-runtime-hardening-audit-harvest
  - 0103-live-admission-terminal-retention
  - 0104-co-1-recovery-intent-reframe
  - 0105-physical-attachment-workspace-handoff
  - 0106-live-ux-capability-dispatcher
---

# LIVE-2 — Liveness hardening: unified dispatcher, declared capabilities, deterministic tests

## Problem

Users miss the ambient liveness signals LIVE-1 shipped: reactions don't appear or
vanish, typing indicators stop or never start, and nothing in the logs says why. Two
independent reviews (Fable determinism audit, 10 findings; Codex xhigh holistic review)
located the cause outside the hardened per-card ordering machinery: per-provider
hand-rolled error handling (Telegram catches, Discord throws, Slack lacks typing
entirely, Teams advertises a reaction no-op), silent failure paths (rate limits at
debug level, multi-account sink resolution silently returning undefined), lifecycle
gaps (a reaction await that can block the turn; setup failures that strand ⏳ forever),
and tests that assert internal call order against instant-success mocks instead of
final provider-visible state. Spec: `docs/specs/live-2-liveness-hardening.md`.

## Scope / Non-goals

In scope: the liveness reshape (declared `liveUx` capability + one route-aware
dispatcher + single phase controller), the 12 correctness fixes, the proven deletions,
and determinism test hardening — as specified in the spec's sections A–D.

Non-goals: progress-ordering machinery internals (mechanism audit: all load-bearing);
Slack typing emulation (locked: declared absence); real Teams reactions (bots cannot;
decision 0033); content/canvas work (CONTENT-1 lane); provider SDK upgrades.

## Acceptance Criteria

1. Every adapter's liveness support is declared in one optional `liveUx` capability
   object (`typing: none|expiring`; `reactions: none|{removal: exact|all}`); no
   inferred casts, no advertised no-op operations. Teams declares `reactions: none`;
   Slack declares `typing: none`.
2. One route-aware dispatcher owns reactions + typing delivery for all providers:
   bounded best-effort deadlines, catch-and-warn policy, rate-limit warn + retry-once,
   missing-sink loud diagnosis. Discord setTyping can no longer fail a turn.
3. Liveness phase (`active|delivering|waiting|stalled|terminal`) has one owner;
   reaction admission and terminal restoration share one finally scope — no path
   strands ⏳ (including pre-agent setup failures and live-execution finalization).
4. The first-reaction send cannot block turn start (bounded or detached).
5. Telegram: replace-only edits never create a duplicate on edit failure (ambiguous,
   sticky); reaction flips are no-op-flagged (no remove-all wipe); typing carries
   message_thread_id into topics.
6. Slack: after a restart, a card persisted by a prior process is terminally marked
   stale (best-effort) and new work posts a fresh card — no update is ever silently
   rejected into muteness (stale-and-repost, grill-locked); restart test uses real
   restart arithmetic.
7. Discord: thread reactions never fall back to the parent channel; the test asserting
   that fallback as success is fixed.
8. Batch turns place the seen-reaction by backwards-scan (parity with
   continuation receipts); the first-output flip race settles to exactly one terminal
   reaction.
9. Typing resumes after stall recovery; never shows during a stall (invariant kept).
10. Deletions land: three lifetime reaction-dedupe registries, the unreachable
    undispatched-stall rollback, and the unused multipart alias map. The Discord
    active/tombstone map collapse is DEFERRED (grill-locked) with a ledger trigger:
    the next bug traced to the dual-map migration logic reopens it.
11. Liveness suites assert final provider-visible state through a shared stateful fake
    provider (rendered card text, reaction set, single-card, no-duplicate,
    concurrency ceiling), with failure/latency/restart falsifiers; one flow-level
    admission→lifecycle→wiring→channel test; two-account sink tests. Each correctness
    fix has a falsifier that fails on the LIVE-1 tree.
12. verify.py green; agent-e2e delta recorded.

## Technical Approach

Order the work so the reshape lands first and the point-fixes land ON the new shape
(avoids patching code that is about to move):

1. **Capability + dispatcher core** (`apps/core/src/runtime/` new module +
   `channel-provider.ts` contract): add the optional `liveUx` declaration to the
   provider contract; build the route-aware dispatcher (deadline, error policy,
   retry-once on rate limit, sink diagnosis); wire reactions + typing through it;
   delete the cast-based capability inference and the Teams no-op advertisement.
   Progress sending stays on the existing sender (identity-ambiguity semantics).
2. **Phase controller** (`group-liveness-state` + `group-progress-heartbeats` +
   `group-processing` consolidation): one `GroupLivenessController` owning the phase
   enum; admission/terminal in one scope (fixes stranded-⏳ and turn-blocking await);
   stall→recovery re-enables typing. Sticky stall claim, delivery lease, retry delay,
   first-output guard remain as internal state.
3. **Provider fixes on the new shape**: Telegram (replace-only ambiguity, flip flag,
   topic typing), Slack (restart stale-and-repost), Discord (thread-reaction fallback
   removal), batch backwards-scan, flip-race settlement.
4. **Deletions**: dedupe registries, unreachable rollback, alias map — each with a
   test proving the behavior it guarded still holds. (Tombstone-map collapse
   deferred; ledger row with trigger.)
5. **Test hardening**: shared stateful fake provider; falsifiers per fix (red on
   LIVE-1 tree, green here); flow-level chain test; two-account tests.

## Decisions

- `docs/decisions/0106-live-ux-capability-dispatcher.md` (new): adapters declare
  liveness in a `liveUx` capability object; one route-aware dispatcher owns
  reaction/typing delivery policy; Slack typing is declared absent (no emulation);
  typing resumes on stall recovery. Locked with Ravi in chat 2026-08-04.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Liveness delivery policy, stall-recovery typing, lifecycle scopes |
| API | Unchanged by design | No HTTP/MCP surface changes; provider contract is internal |
| Data/schema | Changed | Slack persisted progress-state gains restart-staleness handling (channel state JSON, no SQL migration) |
| CLI/ops | Unchanged by design | No commands or config added; observability is log-level only |
| UI | N-A | No web UI in scope |
| Docs | Changed | Spec + behavior→test map + decision record |
| Tests | Changed | Fake-provider harness, falsifiers, flow-level chain test |

## Task Decomposition

Sized for one bounded stage each; implementer writes and records the tests.

- LIVE-2-1: `liveUx` capability contract + route-aware dispatcher + wiring +
  Teams/Slack truthful declarations (spec A; criteria 1, 2).
- LIVE-2-2: `GroupLivenessController` phase ownership; admission/terminal single
  scope; bounded first-reaction; stall-recovery typing (spec A; criteria 3, 4, 9).
- LIVE-2-3: Telegram + Slack + Discord provider fixes on the new shape (spec B;
  criteria 5, 6, 7, 8).
- LIVE-2-4: deletions with behavior-preservation proofs (spec C; criterion 10).
- LIVE-2-5: determinism test hardening — fake provider, falsifiers, flow-level and
  two-account tests (spec D; criterion 11; user_facing functional check).

## Risks

- The dispatcher touches every provider's hot path — a policy regression would be
  provider-wide. Mitigation: flow-level test + per-provider falsifiers before the old
  paths are deleted.
- Slack stale-and-repost: a restart mid-turn could briefly show a stale card plus a
  fresh one. Accepted (grill-locked) — visible truth beats silent muteness; the stale
  edit is best-effort and idempotent.
- Concurrent CONTENT-1 lane touches Slack files. Mitigation: LIVE-2 avoids
  `channels/slack/canvas*`; merge-ordering with CONTENT-1 is human-sequenced.

## Verify Plan

- Per stage: focused vitest suites for the touched modules + local autoreview until
  clean, then commit (standing local-before-commit rule).
- Story close: `python3 factory/scripts/verify.py` (full lanes, run solo), ONE 3-lens
  branch autoreview, functional check via delegated stage (user-facing), agent-e2e
  delta, then pr_ready.
- Falsifier proof: each correctness fix's test demonstrated failing against the
  LIVE-1 tree (spot-check by reverting the fix commit locally, not by CI).
