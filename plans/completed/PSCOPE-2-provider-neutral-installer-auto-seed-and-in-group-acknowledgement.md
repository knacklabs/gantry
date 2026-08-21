---
issue: PSCOPE-2
title: Provider-neutral installer auto-seed and in-group acknowledgement
status: approved
saved: 2026-08-10T12:21:36+00:00
story: PSCOPE-2
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
  - 0106-scheduled-runs-cannot-mutate-jobs
  - 0107-typed-permission-decision-provenance
  - 0108-job-definition-revision-fencing
  - 0109-semantic-capability-job-dependencies
  - 0110-live-ux-capability-dispatcher
  - 0112-legacy-single-canonical-shape
  - 0113-enforce-no-backcompat-architecture-check
  - 0114-canonical-job-owner
  - 0115-autonomous-tool-denial-terminal
  - 0117-scheduled-job-declare-tools-at-creation
  - 0118-identity-scoped-approval-and-grants
  - 0119-provider-neutral-group-approver-bootstrap
---

# PSCOPE-2 — Provider-neutral installer auto-seed + in-group acknowledgement

## Problem

Adding the bot to a group is dead air. The only onboarding flow that exists (Telegram) never posts anything in the group, and it cannot mint a first approver: it only asks an ALREADY-listed approver via a DM Yes/No prompt (`channels/telegram/group-join-onboarding.ts:66-133`) and seeds that existing approver — the installer is ignored. A fresh deployment can never bootstrap (the flow aborts at :80-86 when the adder isn't already an approver somewhere). Recognition is settings-allowlist-based, not identity-based; Slack/Discord/Teams have no join handling at all. Decision 0119 (accepted) mandates the provider-neutral fix; PSCOPE-1 shipped the DM half of approval authority, groups still need their bootstrap.

## Scope / Non-goals

In scope: one shared bootstrap flow; Telegram + Slack installer extraction; Discord manual-fallback message; deletion of the Telegram DM Yes/No propagation flow; decision 0119 amendment recording the locked semantics.

Non-goals: Teams join surface (no `conversationUpdate` plumbing exists; adding a provider later is local per 0119 — documented manual for now); org-tier approver routing (D-0054); any change to group approval CHECKS (allowlist stays authoritative, fail-closed when empty); no new port/registry for installer extraction (nullable argument suffices).

## Acceptance Criteria

1. A DM-established person adding the bot to a new Telegram or Slack group: the group auto-registers, the installer becomes its first (only) control approver, and a short acknowledgement posts IN the group.
2. An unrecognised installer registers nothing and seeds nobody; the group gets one message naming how to set an approver (fail-closed). Discord posts the same manual-setup message on new-guild join; Teams is documented manual.
3. Re-adds/reconnect refires never spam (one ack/manual message per group, `group_join_onboarding` row is the dedup key) and never clobber an existing approver list.
4. The Telegram DM Yes/No prompt flow is fully removed (handler, callback route, recordPrompt machinery, tests) — one flow remains.
5. The seeded approver survives desired-state reconcile (the participant-validation trap is closed, not skipped).

## Technical Approach

**Shared bootstrap** — new `apps/core/src/channels/group-install-bootstrap.ts` (~80 lines), called by each adapter's join event with `{opts, provider, providerAccountId, chatJid, title, installerExternalId?, send}`:
1. `opts.onChatMetadata(...)`; bail if the conversation is already registered (as Telegram does today).
2. Dedup on the existing `group_join_onboarding` row (columns `adder`/`approver` already fit; `approver = adder`).
3. Resolve installer: `resolvePersonIdentity({..., createIfMissing:false})` (`application/identity/person-identity-service.ts:246` — lookup-only, does NOT violate ID-1's DM-only minting; catch the retired-alias throw → unrecognised). **Recognised = the person also has a direct-kind conversation** (new small repo query `hasDirectConversationWithPerson(appId, personId)` joining `user_aliases` × conversation participants × `conversations.kind='direct'` — because `ensureParticipant` auto-mints aliases for any group speaker, so alias-exists alone is too loose).
4. Recognised → register + seed through the existing coordinator: extract the settings-write block from `config/settings/group-join-onboarding.ts::register` into a shared `seedInstaller` (same `applyConversationInstallToSettings({controlApprovers:[installer]})` + `writeDesiredRuntimeSettings`; `conversation-install-settings.ts:60-64` already preserves non-empty existing lists). Then post the ack via the adapter's own `sendMessage` (route-free; failures non-fatal).
5. Unrecognised → post the manual-setup message; nothing else.

**The reconcile trap (must-fix, AC5):** `desired-state-conversation-reconcile.ts:367-386` rejects any approver not present in `listParticipantExternalUserIds`, and participants only appear on message ingest — so a fresh group's seed would silently land in `skipped`. Fix: at seed time upsert the installer as a conversation participant (they provably ARE a member — the provider join event names them), reusing the participant-write path `canonical-graph-repository.postgres.ts::ensureParticipant` reachable via a repo method; the reconcile check stays intact.

**Providers:**
- Telegram: rewire `my_chat_member` (`channel-connect.ts:752`) to the bootstrap with `String(update.from.id)`; DELETE `handleTelegramGroupJoinCallback`, the DM prompt send, `recordPrompt`, and the callback route (:78-92) — full plumbing cleanup.
- Slack: subscribe `member_joined_channel` in `channel-interactions.ts`; when `event.user` is the bot, `event.inviter` is the installer (absent → unrecognised path). Document the required event subscription + `channels:read`/`groups:read` scopes in `docs/operations/slack-app-install.md`.
- Discord: on `GUILD_CREATE` for an unregistered guild (`discord-gateway-dispatch.ts:26`), post the manual-setup message to the system channel when available; dedup via the onboarding row (GUILD_CREATE refires on every reconnect). No installer extraction (no inviter in the event; audit-log lookup is out of scope).
- Teams: docs note only (no activity surface exists).

**Copy** (plain language, per communication policy): ack ≈ "I'm set up. {installer} can approve what I'm allowed to do here."; manual ≈ "I don't know who added me. An existing approver can register this group from settings (docs link)."

## Decisions

Amend 0119 with the grill-locked semantics (confirmed by Ravi in chat, 2026-08-10): (a) recognition IS the registration gate — recognised installer auto-registers the group and becomes first approver, replacing the DM-propagation gate; (b) recognised = resolvable alias AND an existing direct conversation (DM-established), because aliases auto-mint for group speakers; (c) the Telegram DM Yes/No flow is deleted, not kept alongside.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | group install bootstraps; Telegram DM prompt flow removed |
| Data/schema | Unchanged | reuses `group_join_onboarding` + participant rows; no migration |
| API/CLI | Unchanged | none |
| UI | Unchanged | chat messages only |
| Docs | Changed | 0119 amendment; Slack manifest ops note; Teams manual note |
| Tests | Changed | telegram.test.ts group-join suite rewritten; new bootstrap/Slack/Discord/parity tests |

## Task Decomposition

1. **PSCOPE-2-1** — shared bootstrap + `seedInstaller` extraction + DM-established recognition query + installer participant upsert; unit tests for recognised/unrecognised/dedup/preserve-existing-approvers and the reconcile-survival path.
2. **PSCOPE-2-2** — Telegram rewire + delete the DM prompt/callback flow; rewrite `telegram.test.ts` group-join suite (recognised seeds+acks in group; unrecognised gets guidance; no DM messages remain).
3. **PSCOPE-2-3** — Slack `member_joined_channel` + inviter extraction + ops doc; Discord GUILD_CREATE manual fallback + dedup; provider parity test; Teams docs note; 0119 amendment.

## Risks

- Settings authority: the seed MUST go through `applyConversationInstallToSettings` → desired-state write; a direct `conversation_approvers` write is erased on the next reconcile.
- Replace-not-append: `replaceConversationApprovers` is destructive — the already-registered guard plus the preserve-on-empty behavior must be pinned by a test so a re-join can't clobber a configured allowlist.
- The participant upsert must not weaken the reconcile membership check for any other path — it adds the installer only, with the provider join event as evidence.
- Deleting the DM flow removes the "stranger added the bot but a known approver adopts it" path; the manual-setup message must carry enough instruction to cover it.
- Slack works only after the app manifest gains the event + scopes — code lands dark until ops applies it (documented; the doctor already warns on missing Slack scopes).

## Verify Plan

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/channels apps/core/test/unit/config apps/core/test/unit/application apps/core/test/unit/bootstrap
python3 factory/scripts/verify.py
```
Live smoke after merge: add the bot (from the DM-established account) to a scratch Telegram group → group registers, installer listed as approver (`conversation_approvers`), ack posts in-group; repeat with an unrecognised account → manual message, no registration.
