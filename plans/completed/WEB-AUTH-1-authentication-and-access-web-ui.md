---
issue: WEB-AUTH-1
title: Authentication and Access Web UI
status: approved
saved: 2026-08-18T10:48:07+00:00
story: WEB-AUTH-1
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
  - 0122-capability-template-amendment
  - 0123-recovery-proposal-birthright
  - 0124-bounded-durable-card-delivery
  - 0125-host-only-template-amendment
  - 0126-typed-terminal-denial-event
  - 0127-tagged-setup-action-model
  - 0128-permission-approval-result
  - 0129-capsafe-local-cli-terminal-wildcard
  - 0130-capsafe-capability-run-dispatch-only
  - 0132-adaptive-browser-authentication-access
---

# WEB-AUTH-1 — Authentication & Access Implementation

## Problem

Gantry has machine API-key authentication but no browser-specific trust path.
Implement the approved local and hosted console authentication design while
keeping `/v1/*` Bearer authentication unchanged.

## Scope / Non-goals

Deliver local loopback authorization, generic OIDC (Google first), opaque
browser sessions, access grants/invitations, recovery CLI, same-origin browser
facade, and the approved Authentication & Access UI. Do not add emailed
invitations, an Operator role, public recovery, custom roles, multi-tenancy,
extra IdPs, a browser Bearer fallback, or live APIs for unrelated fixture UI.

## Acceptance Criteria

1. Local browser authorization is loopback-only, single-use, hash-only, and
   creates a revocable session.
2. Hosted OIDC uses issuer plus subject identity, validates its full protocol
   boundary, and preserves the independent Bearer API contract.
3. Administrators manage access, invitations, sessions, and staged OIDC setup
   without exposing a secret or reusable credential.
4. The exact approved lifetimes, roles, copy, recovery, audit, CSRF/origin,
   cookie, and final-administrator invariants hold.

## Technical Approach

Use the existing Postgres/Drizzle migration and repository pattern, Person and
alias identity model, settings revisions, `RuntimeSecretProvider`, DNS-pinned
transport, Control server, audit events, and React primitives. Add a focused
authentication application module and Postgres repository rather than a second
identity directory or browser-to-Bearer bridge. Add `jose` directly for OIDC
signature/claim validation.

Persist only hashes of authorization, session, invitation, and recovery
reference tokens; atomically consume one-use rows. Encrypt the short-lived
server-side PKCE verifier. Resolve OIDC aliases internally as
`oidc/<issuer>/<sub>` and create a distinct verified email alias; email never
selects a Person. Revalidate the grant, role, and session on every facade
request and stream heartbeat.

Add the authentication settings subsection independently of deployment mode:
mode, canonical origin, generic OIDC issuer/client/domain/provider label, and
secret reference. Candidate settings test through the adapter without changing
active runtime configuration; activation promotes a revision.

Mount public `/auth/*`, protected `/ui/api/auth/*`, and `/ui` only on the full
Control profile. Browser mutations reject Bearer credentials and require exact
Origin plus CSRF. `/v1/*` rejects browser cookies. Keep all user-facing and
audit errors safe and classified.

## Decisions

- `docs/decisions/0132-adaptive-browser-authentication-access.md` implements
  the approved design and extends `0101`; it fixes roles, lifetimes, recovery,
  session isolation, and candidate activation.
- `docs/decisions/0101-oidc-generic-google-first.md` fixes generic OIDC,
  Google-first configuration, issuer-plus-subject identity, and app `default`.
- No new decisions. Use installed transitive `jose` as a direct dependency as
  required by the approved design; do not implement cryptography manually.

## Surface Impact

| Surface | Status | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Local/hosted browser authentication and sessions. |
| API | Changed | Separate same-origin facade; `/v1/*` remains Bearer-only. |
| Data/schema | Changed | Codes, OIDC transactions, sessions, grants, invitations. |
| CLI/ops | Changed | Local authorization and trusted access approval. |
| UI | Changed | Public auth routes and Authentication & Access settings. |
| Docs | Changed | Startup, proxy, recovery, and OIDC setup documentation. |
| Tests | Changed | Protocol, storage, HTTP, CLI, and web coverage. |

## Task Decomposition

1. **AUTH-1 foundations** — add shared auth contracts, settings candidate
   shape, Postgres schema/migration/readiness, repository atomic operations,
   trusted alias attestation, and tests for hash/expiry/final-admin invariants.
2. **AUTH-2 server boundary** — add session/cookie/CSRF/origin policies,
   full-profile auth routes, local authorization, browser facade authorization,
   and HTTP boundary tests. Preserve `/v1` authentication unchanged.
3. **AUTH-3 hosted identity** — add provider-neutral OIDC adapter using
   DNS-pinned transport and `jose`, transactions/PKCE/callback validation,
   grants/invitations/reauth/session rotation, and mocked OIDC tests.
4. **AUTH-4 operations** — add `gantry ui`, `gantry ui authorize`, and
   `gantry auth access approve`; add safe audit events, configuration test and
   activation flow, plus documentation/recovery guidance.
5. **AUTH-5 web UI** — add public authentication pages and protected
   session-aware routing, then local/hosted Authentication & Access screens
   using existing primitives, exact approved copy, and accessibility behavior.
6. **AUTH-6 integrated proof** — run disposable-Postgres, HTTP, CLI, web,
   architecture/migration, security-cleanup, and full build verification;
   resolve findings before the one required autoreview and functional check.

## Risks

The highest-risk seams are credential confusion, token replay, stale grant
authorization, and OIDC validation. The plan keeps them server-side and
proves them at repository, HTTP, and mocked-provider boundaries. The recurring
`delivery-semantics` finding concerns scheduled-job delivery, not this
authentication boundary; if an auth change triggers the class in review, stop
and record the required invariant instead of patching a local symptom.

## Verify Plan

- Unit: token hashing/expiry/replay, cookie flags, origin/CSRF, scope mapping,
  final-admin transaction, recent auth, and safe error projection.
- OIDC contracts: discovery/JWKS/token mocks for issuer, state, nonce, PKCE,
  signature, audience, expiry, malformed responses, timeout, callback replay.
- Disposable Postgres: concurrent consumption, rotation/revocation, grants,
  access reference, audits, and settings candidate/test/activation.
- HTTP/CLI/web: credential mutual rejection, no-store, loopback/rate limits,
  event revocation, commands, exact copy, routing, Viewer restrictions,
  keyboard/focus/themes/reduced motion.
- Finish with web and core format/lint/typecheck/build, migration and
  architecture checks, `python3 factory/scripts/verify.py`, one autoreview
  pass, and the required functional-checker flow.
