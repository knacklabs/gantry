---
slug: v2-first-agent-onboarding
title: V2 first-agent onboarding
status: confirmed
saved: 2026-11-26T09:51:45+00:00
confirmed_by: "Ashirwad Shetye"
confirmed_hash: 55a39e5c1b960d60c2989c61e4938cee00c6a17096ff772bb9166d82335e0bb5
---

# V2 first-agent onboarding

## Why

The existing first-run setup must take an already-authenticated administrator
of an otherwise unconfigured deployment to a real, verified AI employee
without exposing credentials or relying on a terminal. First-administrator
bootstrap and recovery remain the separate CLI/OIDC flow from decision 0132.
The supplied V2 onboarding reference defines the desktop/tablet visual
primitives. The companion visual contract records every deliberate product
deviation requested after that prototype; active security, credential, and
readiness decisions always win over prototype behavior.

## Behaviour

- `/ui/onboarding` remains an authenticated administrator route outside the
  Console shell and mounts only in the Control server's full profile. It never
  bootstraps browser access or weakens Origin, CSRF, or re-authentication
  controls. An expired re-authentication never auto-replays a pending mutation;
  an explicit retry reuses that logical request's persisted idempotency key.
  Desktop and tablet use the 266px left rail; mobile retains a natural
  document-scroll fallback.
- The splash collects the employee name and job title and validates both before
  starting. Its only local state is a namespaced `sessionStorage` identity
  draft, scoped to the browser tab, never containing credentials, and cleared
  once Employee creation succeeds. Durable setup always resumes from backend
  state; Back returns to the splash without changing completed state.
- Step 1 uses the V2 identity/model presentation. It limits first-run model
  providers to Anthropic, Amazon Bedrock, OpenAI, OpenRouter, and Google Vertex
  AI. Multi-mode providers require an explicit authentication-method choice;
  the selected model alias and `agentHarness` (`auto`, `anthropic_sdk`, or
  `deepagents`) are persisted through the existing Agent desired-state path and
  fail closed when incompatible. The initial save is idempotent and atomically
  creates Agent, service-kind Person, desired-state revision, audit event, and
  the single authoritative onboarding setup for the app. A repeated key with
  the same request returns that result; a changed payload conflicts. Model-
  provider credentials use only the typed model-credential facade; successful
  writes clear raw values from browser state. Its explicit verification is a
  Gantry configuration/reference check, not an upstream authentication probe:
  failure leaves the prior healthy reference authoritative and creates no
  failed credential. Only a passing check unlocks and refreshes the selectable
  model aliases. Model credentials never use runtime-secret references. If browser
  model-credential mutation is disabled by policy, an already healthy typed
  credential remains usable; otherwise the UI reports deployment-deferred and
  cannot advance.
- Step 2 shows only live V2 channel providers in deterministic order: Slack,
  Teams, Discord, Telegram. Slack is selected when available; otherwise select
  the first provider in that order which declares both conversation discovery
  and runtime verification support. Setup-only providers may be visible but
  cannot complete the deployment flow. A created Provider Account is owned by
  this Agent and projected as a provider-account alias of its service Person
  before Connect can complete. Slack uses runtime-secret ingest—not model
  credentials—for `xapp-` and `xoxb-` values, clears successful raw input state,
  opens the backend-generated manifest URL, and performs real discovery. Its
  shared secret-reference field accepts write-only raw values or named
  `env:`/`aws-sm:` references; policy-disabled ingest exposes references only.
  Empty discovery returns `CONVERSATION_DISCOVERY_EMPTY` with retry guidance
  and never marks Connect complete. Slack token or scope problems report a
  specific, actionable validation error (wrong token type, missing scope,
  revoked or unknown workspace) instead of a generic failure. Discovery also
  lists public channels the bot can see but has not joined, marked as such and
  returned in bounded pages. Choosing one joins the bot to that channel only
  when the administrator explicitly selects Join; a failed join leaves the step
  incomplete with retry guidance. Private channels still require inviting the
  bot in Slack.
- Onboarding completes only through Slack in this release. Teams and the other
  providers stay visible as setup-only and cannot complete the flow until a
  later story proves them end to end.
- Step 3 selects one discovered conversation and persists the installation
  through Provider Account -> Conversation -> Conversation Installation. A DM
  resolves its counterpart as approver without a group allowlist. A group uses
  an existing recognised installer seed when present, otherwise selects a
  discovered member; manual entry is allowed only without member discovery and
  must still pass membership validation. The approver PrincipalRef resolves to
  that human Person; the provider-account alias resolves to the Agent's service
  Person. Member lists are bounded and paged, never loaded whole.
- Step 3 also sets who may get replies from the employee in that
  conversation, chosen from its members. This follows decision 0090: the list
  gates only who can trigger a reply. Every message in the conversation is still
  saved and available as context, whoever sent it. The approver is always on the
  list. Leaving the list empty means every member can trigger a reply, as today.
  The rule applies for the life of the conversation, not only during onboarding.
- Choosing a different conversation in Step 3 disables the installation that
  onboarding created for the earlier choice and removes it from the runtime
  projection, so the employee stops replying there. Its reply list goes with it.
  A conversation installation that existed before onboarding is never disabled
  by onboarding.
- Step 4 creates a server-owned challenge for that installed conversation and
  reports pending, inbound-received, expired, or completed state. Readiness
  requires the real correlated inbound event and the Agent's correlated
  outbound reply—not a timer or simulated result. Readiness additionally
  requires successful runtime projection. Projection failure reports
  `RUNTIME_PROJECTION_FAILED`, remains retryable, and cannot consume or complete
  the challenge. Expired verification reports `VERIFICATION_EXPIRED` and offers
  a fresh challenge; pending verification reports `VERIFICATION_PENDING`.
  The challenge reply must come from a person allowed to trigger replies in
  that conversation.
  Console handoff is disabled until completion, and no other link on the
  onboarding screens (including the brand mark) enters the Console early. A
  failure to load onboarding status shows an error with retry; it is never
  treated as completed. Durable resume begins from the
  app's unique onboarding-setup record and derives each completed gate from its
  persisted Agent, account, alias, installation, approver, projection, and
  verification records.
- Changing an upstream durable choice invalidates only dependent progress:
  provider/auth mode/model/harness invalidates validation and Steps 2–4;
  channel/account invalidates conversation, approver, and verification; a
  conversation or approver change invalidates verification. Navigation without
  changes performs no writes and preserves completed state. Invalidated records
  remain auditable but cannot authorize Console handoff.
- Every mutating browser request carries a client-generated idempotency key that
  is persisted with a payload fingerprint and result. Timeout or explicit
  post-reauthentication retry reuses the key; key reuse with a different
  payload returns `IDEMPOTENCY_CONFLICT`. Concurrent Agent creation,
  installation, and challenge requests therefore return one durable result.
- While onboarding is incomplete, an administrator who reaches the Console sees
  a reminder to finish it, with a link that resumes at the last valid step. An
  administrator can dismiss the reminder for themselves. It disappears for
  everyone once onboarding completes.
- An unexpected error anywhere in the web app shows a recovery screen with
  Retry and Reload, instead of a blank page. The screen shows no secrets, stack
  traces or raw upstream bodies.
- The UI matches the V2 typography, tokens, assets, layouts, interaction
  states, and motion. Motion is reduced for browser/system and saved Gantry
  reduced-motion preferences. Transient feedback uses one themed Sonner host at
  the viewport's bottom-right; inline validation remains next to the field.
  Onboarding typography and styles stay scoped to the onboarding screens and do
  not change existing Console pages.
- Existing agent, Person, desired-state, audit, typed model credential,
  runtime-secret, account, conversation-installation, approver, and
  verification API contracts remain authoritative. Browser routes enforce
  canonical Origin, synchronizer CSRF, recent re-authentication, no-store
  responses, administrator mutations, Bearer/session separation, and safe
  audit metadata. Browser errors use the existing typed `{ code, message }`
  envelope. `CREDENTIAL_VALIDATION_FAILED`, `PROVIDER_NOT_READY`,
  `CONVERSATION_DISCOVERY_EMPTY`, `CONVERSATION_MEMBERSHIP_REQUIRED`,
  `RUNTIME_PROJECTION_FAILED`, `VERIFICATION_PENDING`, `VERIFICATION_EXPIRED`,
  and `IDEMPOTENCY_CONFLICT` map to specific inline guidance or retry actions;
  response details and audit metadata never contain secrets or raw upstream
  bodies. This adoption does not redesign the Console after onboarding.

## Acceptance criteria

- The splash and Steps 1–4 reproduce the visual primitives in the versioned
  reference at
  `docs/reference/onboarding/gantry-onboarding-v2.dc.html`, SHA-256
  `c1dc1305abd4876f74ac7b0c8e097205c891b3478fb3ab7f7db1ec6f72259a45`, with
  intentional post-prototype changes governed by the companion visual contract.
  The pinned Playwright environment covers every named viewport and state with
  zero unexpected changed pixels against the applicable reference or reviewed
  contract baseline.
- Visible copy, provider/channel order, defaults, labels, and state names are
  regression-tested against the visual contract; prototype strings or fixture
  defaults explicitly replaced there are not shipped.
- A valid first-run setup atomically creates the governed Agent/Person/revision/
  audit tuple and resumes only durable state. Skip is absent; Back preserves the
  ephemeral identity draft. Completed steps survive navigation, while the
  defined upstream changes invalidate dependent gates and unchanged inputs do
  not trigger redundant writes. Retried or concurrent mutations are
  idempotent, while a reused key with changed input fails closed.
- Browser values are write-only, administrator- and CSRF-protected, cleared
  after successful ingestion, never logged/audited as values, and never present
  in responses. Model credentials and channel runtime secrets remain separate
  trust lanes.
- Model aliases remain locked until the explicit configuration verification
  passes; saving requires a compatible selected harness and alias. Multi-mode
  providers require an explicit authentication method.
- Slack Create opens the server-generated manifest URL, Connect accepts and
  validates the two token types, and discovery errors or empty results remain
  actionable rather than completing the step.
- Verification records enforce expiry, replay, agent, provider-account,
  conversation, inbound, and outbound correlation checks. A user can resume
  created setup after a reload and reaches Console only after completed
  verification and successful runtime projection; pending, expired, and failed
  projection states cannot open Console.
- Slack token and scope problems show specific guidance. A visible but
  unjoined public channel can be joined by an explicit administrator choice,
  and a failed join leaves the step incomplete.
- Only allowed members can trigger replies in the onboarded conversation, while
  every member's messages are still saved as context. The approver is always
  allowed, and an empty list allows everyone.
- An incomplete onboarding shows a dismissible Console reminder that resumes
  the flow and disappears once onboarding completes.
- An unexpected web error shows a recovery screen with Retry and Reload and no
  sensitive detail.
- Core and disposable-Postgres tests cover the browser authorization controls,
  secret clearing, invalidation graph, empty discovery, Slack join, allowlist,
  correlation, and blocked Console handoff. Each user-visible result has one
  end-to-end test, run nightly. The existing web unit tests are reset: only
  the onboarding model-setup, Console-handoff and visual-acceptance tests are
  kept or added, and the web test script passes with no other tests. Fresh
  Slack tenant proof remains a release gate. Teams is visible as setup-only and
  cannot complete this flow in this release.

## Success measure

- Metric: Time from the first administrator's browser login to a verified Slack
  employee, with no terminal step, and the share of new deployments that finish
  without asking for help.
- Baseline: No browser onboarding exists on main; every first setup needs the
  terminal.
- Target: The median new deployment finishes in 20 minutes or less, and 9 in 10
  finish without help.
- Check date: 2027-01-31

## Non-goals

- Redesigning the Console after onboarding or replacing the broader seven-step
  deployment lifecycle from decision 0156. This four-screen flow is a focused
  presentation over the same durable lifecycle, not a separate state machine.
- Returning stored credentials to the browser, fabricating provider results, or
  shipping compatibility paths for pre-release onboarding data.
- Porting either earlier onboarding branch wholesale. Both are references for
  behaviour only; the flow is rebuilt on current main and reuses main's
  existing browser-auth, model-credential, provider-account, discovery,
  approver and Bedrock code. Onboarding adds exactly one generated migration
  from current main's schema, as the onboarding rebuild decision records; no
  historical snapshots are carried over and no back-compat path is added
  (decision 0003).
- Completing onboarding through Teams or any provider other than Slack.
- Blocking or dropping messages from members who are not on the reply list
  (decision 0090 keeps the list trigger-only).
