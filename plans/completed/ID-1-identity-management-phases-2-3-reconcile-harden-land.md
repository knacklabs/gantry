---
issue: ID-1
title: Identity management phases 2-3: reconcile, harden, land
status: approved
saved: 2026-08-01T13:40:45+00:00
story: ID-1
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
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0100-mig-1-client-signoff
---


# ID-1 — Identity management phases 2-3: reconcile, harden, land

## Context

PR #217 (Suraj, 33 commits, +9277/-497 across 149 files) implements canonical per-app
person identity: `personId` with provider/email/phone/web aliases, live-turn sender
resolution, a conversation-vs-personal memory boundary, and a People API (resolve, list,
inspect, alias add/retire, merge preview/apply). It is 59 commits behind main and its 7
sequential migrations (0116-0122) collide with main, which moved to timestamped
migrations (#366). A grill on 2026-08-01 confirmed the FOUNDATION is right (app-scoped
person; free-string providers; verification with evidence; no auto-linking; merge never
re-keys memories/messages) and locked eight decisions recorded below.

## Decisions

Confirmed by Ravi via grill + AskUserQuestion, 2026-08-01:

1. Person stays APP-SCOPED: the same human in two Gantry apps is two unrelated people.
   "Other apps read/write memories" means external clients within an app (future
   memory-MCP), never cross-app identity.
2. NO user-type column. Admin = authorization (API-key scopes, later OIDC claims).
   Employee = has a VERIFIED alias from the org IdP. Application user = everyone else.
3. OIDC alias = provider `oidc`, providerAccountId = issuer, externalUserId = `sub`.
   Never keyed on email; the email travels as a separate contact alias.
4. NEVER auto-link on email/phone match — matching contact data yields a suggestion for
   explicit confirmation, not a link. Pinned by test.
5. Contact aliases are NORMALISED at write time in the identity service: email
   lowercased, phone to E.164. Existing rows are backfilled by migration; a collision
   under the active-alias unique index aborts the migration rather than guessing.
6. Suraj's mergePeople stands; an UNMERGE is added that restores the archived source
   person and returns moved aliases from `person_merge_audit`. Merge stays
   memory/message-preserving (verified: it re-keys aliases only).
7. `verified` is SYSTEM-ATTESTED only: settable by flows that prove control (provider
   event, OIDC login, future OTP), never via the People API. Pinned by test.
8. Test bar: boundary rules + the invariants above — personal memory never appended on
   group turns; unresolved sender never rewrites a conversation; exact-match alias
   lookup; normalisation round-trips; no auto-link; verified unsettable via API;
   unmerge restores what merge moved.
9. AGENTS ARE SERVICE-KIND PEOPLE (added 2026-08-01, Ravi): agent-owned identities
   (email, GitHub, connector accounts) attach as aliases to `kind: 'service'` persons
   once connectors land. Personal-memory hydration stays human-only. Pinned invariants:
   live resolution never mints a person for an agent/system sender (today it hardcodes
   kind 'human' at person-identity-repository.postgres.ts:152 — the creation path gains
   an explicit kind and the system-sender skip is tested); mergePeople refuses across
   kinds. Connector OAuth is the system-attested verification flow for service aliases
   (decision 7 applied to agents).

## Approach

Work happens on the `feat/ID-1-identity-management-phases-2-3-reconcile-harden-land`
worktree at `/Users/ravikiranvemula/Workdir/myclaw-ID1` (PR #217's commits with
`git merge origin/main` in progress), superseding PR #217 with a new
PR that preserves Suraj's commits (fork branch, cannot push to it).

1. **ID-1-a Reconcile with main.** Resolve the 9 merge conflicts keeping BOTH the
   identity threading and main's session-observability work (#370: feedConversationIds
   union, persistTurnAssistantTranscript, generation-scoped persistence). Convert the 7
   identity migrations to timestamped names appended after main's chain in their
   original relative order; regenerate the drizzle snapshot; `db:migrations:check` and
   `generate` must report no drift; migration-chain test green on clean Postgres.
2. **ID-1-b Harden to the locked decisions.** Write-time normalisation + backfill
   migration (decision 5); unmerge from person_merge_audit (decision 6); audit and pin
   every `verified` setter (decision 7). Codex explored read-only first via
   `forge delegate ID-1-a --read-only` to critique this plan and inventory the setters.
3. **ID-1-c Boundary tests.** The decision-8 suite, each behavioural test proven to
   fail with its guard reverted.
4. Full unit + Postgres integration suites, local autoreview to clean, nightly e2e
   dispatch via workflow_dispatch (the real-model turn only runs in CI), then a
   superseding PR crediting Suraj; merge once CI is green (standing instruction).

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | sender resolution on live turns; personal-memory routing boundary |
| Data/schema | Changed | 7 identity migrations (timestamped), normalisation backfill, unmerge audit use |
| API | Changed | People API (new surface); unmerge endpoint added |
| SDK | Changed | senderId -> web_user identity evidence; regenerated types |
| CLI/ops | Unchanged by design | no CLI surface in scope |
| UI | Unchanged by design | future UI consumes this; none ships here |
| Docs | Changed | phase-2-3-identity-management.md + OIDC alias convention |
| Tests | Changed | decision-8 boundary/invariant suite |

`user_facing: false` — control-plane API and runtime internals; no shipped UI.

## Verification

- `npm run db:migrations:check` + `db:migrations:generate` (no drift) on the converted chain
- postgres-migration-chain test on a clean database
- full unit suite + Postgres integration lanes
- boundary tests with reverted-guard negative controls
- local autoreview until no actionable findings; nightly e2e green via dispatch
