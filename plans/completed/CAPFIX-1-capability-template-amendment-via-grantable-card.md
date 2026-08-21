---
issue: CAPFIX-1
title: Capability template amendment via grantable card
status: approved
saved: 2026-08-11T16:48:24+00:00
story: CAPFIX-1
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
  - 0120-local-cli-structured-invocation
  - 0121-autodet-no-classifier-autonomous
---

# CAPFIX-1 — Capability template amendment via grantable card

## Problem

A local_cli capability's `commandTemplates` are its authorization boundary
(0120, arity-exact). When a template doesn't fit the CLI's real argv shape,
every `capability_run` fails "Arguments are outside the reviewed pattern" and
the agent has NO recovery: it cannot amend (anti-self-authorization, correct)
and cannot ask a human (no surface exists — the only lever is raw SQL on
`tool_catalog`). Live: the KnackLabs job writes zero leads because
`gog sheets get *` (1 arg) doesn't fit `get <id> <range>`; Ravi rejected the
SQL unblock — the job stays broken until this ships and is this story's live
acceptance test. Spec (confirmed): docs/specs/capability-template-amendment.md.

## Scope / Non-goals

In scope: agent-raised amendment proposal (new `request_access` target kind),
host-side validation + widening classification, durable proposal record with
terminal deny + dedup, plain-language approval card with collapsed technical
delta, CAS catalog amendment (templates only) with provenance/history, and
fix-and-continue into the existing paused-job recovery.

Non-goals: agent self-amendment (never); relaxing arity-exact (0120 stands);
hash/path/version amendment (immutable through this surface); bulk
template-authoring UI; settings mirroring (tool_catalog is the definition
home — settings authority 0007/0025 governs SELECTION, not definitions).

## Acceptance Criteria

1. On a `capability_run` template mismatch the agent can raise a proposal via
   `request_access` target.kind=capability_template_amendment carrying ONLY
   capabilityId, proposedTemplates, observedArgv (evidence, not authority);
   the host derives current templates and executable identity from the
   catalog, never trusting agent copies.
2. Host validation before any card: catalog reload; each proposed template
   passes the existing local-cli template validator + single-leaf
   parseBashCommand (no shell metachars/redirects, pinned executable prefix);
   deterministic widening classification — same executable + identical literal
   executable+subcommand prefix + only ADDED TRAILING positional slots =
   non-widening; anything else (new subcommand, changed/removed literal, added
   flag, different executable) = widening, and the card leads with one plain
   sentence saying so.
3. The card is plain-language: body built from displayName/can/cannot in
   ability terms; buttons "Approve fix" / "Deny"; NO template strings, argv,
   ids, or hashes in the body — technical delta rides the existing full-view
   diff payload (Telegram expandable). One card per proposal (durable dedup).
4. Approve → transactional CAS catalog amendment updating
   implementationBindings[*].commandTemplates ONLY (path/hash/version and all
   other schema fields preserved, optimistic precondition on the prior
   reviewed schema), provenance + prior templates recorded in a durable
   amendment-history row; then the existing paused-job recheck/resume runs
   (fix-and-continue, no re-ask). Deny → terminal, durable, deduped per
   (appId, capabilityId, canonical proposedTemplates, canonical observedArgv);
   never re-raised for the same pair.
5. Live proof: KnackLabs sheets mismatch fixed from the card; next run writes
   leads; no SQL, no restart. Integration proof mirrors the AUTODET-1-2
   lifecycle test: mismatch → proposal → card → approve → catalog updated →
   resume → structured run succeeds; also: denied proposal changes nothing and
   no second card; hash/path amendment attempt rejected.

## Technical Approach

(Seams from the Codex read-only exploration, in order.)

1. **Proposal target + runner IPC.** Fifth discriminated-union arm in
   `registerAccessRequestTool` (runner/mcp/tools/capabilities.ts:43,96-139):
   `{kind:'capability_template_amendment', capabilityId, proposedTemplates:
   string[1..8], observedArgv: string[]}`. `submitCapabilityReviewTask`
   already serializes request_permission IPC with trusted routing
   (service.ts:679-697) — extend payload passthrough.
2. **Host proposal handler.** In ipc-admin-handlers.ts (request_permission →
   requestOnlyCapabilityHandler, :317-350, :394): dedicated branch BEFORE the
   generic persistent-rule path. Validates per AC-2 (reuse the local-cli
   template validator semantic-capabilities.ts:536 + bash-command-parser.ts:84
   single-leaf; widening classifier is new, pure, unit-tested). Durable
   proposal row (new table, unique key per AC-4 dedup; pattern:
   group-join-onboarding.ts:14 unique-row) — pending/approved/denied states;
   denial terminal across workers/restarts. Migration + drizzle schema (mind
   the drift gate).
3. **Card.** Build a `PermissionApprovalRequest`-shaped interaction like
   setup-pause (setup-pause-permission-prompt.ts:180) with proposal-specific
   body composed in permission-interaction.ts:201 from the capability's
   displayName/can/cannot (NOT interaction.details — renders inline); the
   technical delta (current vs proposed templates, failing argv) goes through
   the full-view diff payload (permission-full-view.ts:38; Telegram expandable
   html-render.ts:77). New label seam for "Approve fix"/"Deny" (Telegram
   channel-prompts.ts:211; durable approver-checked callbacks reused, e.g.
   discord-permission-callback.ts:65).
4. **Apply.** New repository op `amendSemanticCapabilityCommandTemplates`
   (transactional CAS: reload active row, precondition on prior schema hash,
   update templates only, write amendment-history row + permission_audit_event
   link). NOT via saveTool (whole-row upsert, no allowlist) and NOT via
   applyRecoveredPersistentPermissionGrant (mutates grants, not definitions).
   Resolution hook: on approve, amend then invoke
   recheckSetupPausedJobsAfterCapabilityUpdate (job-permission-recovery.ts:74)
   for resume. No cache invalidation needed (definitions read per invocation;
   frozen per-turn snapshots mean a mid-run worker sees old templates — the
   resumed next run reloads).
5. **Guidance.** capability_run's invalid_args error text (capability-run.ts:59)
   gains one sentence pointing the agent at the amendment proposal path.

## Decisions

New decision `0122-capability-template-amendment` (number pending origin/main
collision check): templates are amendable ONLY by human-approved,
agent-proposed amendment through the card; executable identity is immutable
through this surface; widening classification is deterministic and
prefix-based; deny is terminal per proposal pair; tool_catalog remains the
definition home (no settings mirror). Grill-locked by Ravi in chat 2026-08-11:
plain-language card (ability terms, technical delta collapsed), leave-broken
over SQL unblock, agent-proposes-human-approves.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | mismatch → proposal card → amend → resume |
| Data/schema | Changed | new proposal/amendment-history table (migration) |
| API/CLI | Unchanged | none (chat card is the surface) |
| UI | Changed | new card type, plain-language copy, new button labels |
| Docs | Changed | decision 0122; spec cross-refs |
| Tests | Changed | runner IPC, host handler, card providers, integration lifecycle |

## Task Decomposition

1. **CAPFIX-1-1** — proposal path + validation + durable record: target kind,
   runner IPC passthrough, host handler branch, template validator reuse,
   widening classifier (pure fn + unit tests), proposal table migration,
   terminal-deny dedup. Units: ipc-mcp-stdio.test.ts, ipc-admin-handlers.test.ts,
   capability-structured-invocation.test.ts (error-text pointer), new
   widening-classifier unit.
2. **CAPFIX-1-2** — card + apply + fix-and-continue: card body/labels/full-view
   diff, amendSemanticCapabilityCommandTemplates CAS repo op + history row,
   resolution hook → paused-job recheck; provider card tests (tg/slack/teams/
   discord), setup-pause-prompt + job-permission-recovery units; Postgres
   integration lifecycle proof (AUTODET-1-2 pattern: mismatch → proposal →
   card → approve → amended → resume → structured run succeeds; deny terminal;
   hash-amendment rejected). Decision 0122 + docs.

## Risks

- Widening classifier soundness: must be conservative — when unsure, classify
  as widening (the card just gets a warning sentence; approval authority is
  unchanged). Pure function, table-driven tests.
- CAS races: two approvals or a concurrent re-review — optimistic precondition
  on prior schema; loser gets a clean "already amended" no-op and the recheck
  still runs.
- Worker-supplied evidence only: host derives everything decision-relevant
  from the catalog (same trap class as AUTODET-1's forged jobId).
- Migration + drizzle drift gate (LAT-5B gotcha); decision-number collision
  check before push (recurring trap).
- Card copy must survive the durable-send sanitizer (allowlist the new view
  or buttons vanish on delivery — bit #313 trap).

## Verify Plan

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runner apps/core/test/unit/jobs apps/core/test/unit/application apps/core/test/unit/channels apps/core/test/unit/shared
GANTRY_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/gantry_test npx vitest run -c vitest.integration.postgres.config.ts apps/core/test/integration/job-lifecycle.postgres.integration.test.ts
python3 factory/scripts/verify.py
```
Live proof after merge + restart: trigger the KnackLabs job → mismatch raises
ONE plain-language card → approve from Telegram → catalog amended with
provenance → job resumes → run writes leads to the sheet. Then re-run twice
more: no cards, leads flow, zero classifier/zero pauses (AUTODET-1 invariants
hold throughout).
