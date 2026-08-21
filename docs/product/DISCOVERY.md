# Discovery — myclaw

Phase 0a. Lightweight on purpose: no .factory ceremony until client sign-off.

## Problem

Gantry (this repo) is a provider-neutral, channel-neutral agent runtime that
has been built over months under an in-repo Codex factory. That factory's
process (Linear-first tasks, `.codex` machinery, gantry-goal-pipeline) grew
organically and was replaced 2026-07-22 by the symphony-forge harness
(`docs/decisions/0002-symphony-forge-adoption.md`) so future goals run through
one deterministic, evidence-recorded pipeline. Product intent lives in
`docs/product/BRIEF.md`; the engineering goal queue lives in
`docs/architecture/goals-index.md`.

## Stakeholders

- vrknetha — owner/lead dev; acts as PM, EM, and client for this repo.
  Sign-off and decision acceptance are theirs.

## Client-approved decisions

<!-- Each becomes docs/decisions/NNNN-<slug>.md via: ./forge decision new <slug> -->

- [ ] `0002-symphony-forge-adoption` — proposed, awaiting human accept
- [ ] `0003-early-stage-no-backcompat` — proposed, awaiting human accept
- [ ] `0004-gantry-naming-and-public-repo` — proposed, awaiting human accept
- [x] 28 pre-harness decision records migrated to numbered, frontmattered form
      (0000–0001, 0005–0033) with historical acceptance transcribed

## Roadmap source (sign-off grill, 2026-07-22)

The forge roadmap is seeded from `docs/architecture/goals-index.md` ordering
(Active → Queued → Then → verified Parked); per-story `acceptance_criteria`
come from each goal's `*-goal-prompt.md` Acceptance Criteria section. Goals
without a committed goal-prompt are not importable until one exists.

## Prototype notes (phase 0b)

Not applicable — the product is long past prototype; live runtime ships from
this repo (see `goals-index.md` Shipped section). Phase 0 here covers the
harness migration itself: legacy `.codex` factory rehomed 2026-07-22
(`check_dual_runtime.py` clean), at-risk lane work rescued to branches, and
scratchpad designs promoted into `docs/architecture/`.

## CONV-001 — Add conversations to an existing agent

### Confirmed problem

An operator can already represent one agent in multiple channel conversations
by editing `settings.yaml`, and the canonical backend supports provider-account
conversation discovery and agent conversation installs. The guided workstation
setup does not expose that capability. Operators must know internal settings
keys or Control API calls to add another Slack channel to an existing agent.

### Confirmed user outcome

From completed setup, an operator can choose **Add conversation to existing
agent**, select or enter an existing agent, reuse that agent's existing provider
account and credentials, select a discovered conversation or enter its provider
conversation ID, set conversation approvers and route behavior, review the
result, and save it without editing YAML.

### Constraints

- The operation is additive. Existing agents, provider accounts, credentials,
  and conversation installs are not replaced or removed.
- Manual agent entry must resolve to an existing agent; this flow never creates
  an agent.
- Manual conversation entry must pass provider-specific validation and access
  verification.
- A conversation already installed for the selected agent/provider account is
  rejected as a duplicate rather than silently rewritten.
- Approvers must pass the provider's conversation-membership validation.
- The desired-state service remains the durable write authority; the canonical
  readable `settings.yaml` copy and Postgres/runtime projection stay aligned.
- Conversation topology changes retain the existing restart-required contract.
- The first implementation uses the existing connectable channel-provider
  catalog rather than adding provider-specific behavior to the application
  layer.

### Acceptance checks

- The completed-setup menu exposes **Add conversation to existing agent**.
- The flow supports discovered selection and validated manual entry for agent
  and conversation.
- The review names the agent, provider account, conversation, approvers,
  sender policy, trigger, trigger requirement, and memory scope.
- Saving produces a separate canonical conversation entry with an
  `installed_agents` binding to the existing agent.
- Existing sibling conversation entries and provider secret references remain
  byte-for-byte equivalent after the write.
- Canceling before confirmation writes no desired-state revision.
- Focused unit and integration coverage proves duplicate, ownership,
  membership, cancellation, settings round-trip, and runtime projection
behavior.

## DOCS-001 — Source-derived documentation

### Problem

Current onboarding and architecture documents contain claims and repository
links that no longer match the implementation on `main`. A developer needs one
source-derived guide and a static project explorer that distinguish current
runtime behavior from historical intent.

### Approved scope

Yash approved the following scope on 2026-07-27:

- audit the complete tracked repository using source code, executable
  registries, schemas, and tests as current-behavior evidence;
- create a self-contained root `index.html` project and architecture explorer;
- document verification boundaries and environment-dependent checks where they
  help developers use the project correctly;
- refresh active onboarding, architecture, SDK, and repository metadata;
- repair broken documentation links without changing the historical meaning
  of review, decision, or migrated-context records;
- preserve historical content when it is evidence of an earlier design or
  review.

### Acceptance checks

- Every tracked file is read byte-for-byte and every JavaScript/TypeScript
  source parses without syntax errors.
- The static explorer renders on desktop and mobile without document-level
  horizontal overflow; search and expandable feature details work.
- Relative Markdown and HTML links resolve after the historical-link repair.
- Architecture checks, type checking, unit tests, and the complete build run.
- Known failures on the audited `main` commit are reproduced and documented,
  not silently reclassified as passing.
