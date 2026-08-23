---
issue: GH-408
title: Establish repository engineering standards and documentation governance
status: approved
saved: 2026-08-21T06:14:27+00:00
story: GH-408
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
  - 0135-docs-001-client-signoff
---

# GH-408 — Establish repository engineering standards and documentation governance

## Problem

Gantry has substantial architecture, quality, decision, and workflow material, but the engineering contract is distributed across tool-specific instructions and mixed-lifecycle documents. Contributors cannot reliably distinguish current architecture from plans, audits, prompts, validations, and historical handoffs, or determine the checks required for a merge-ready change.

## Scope / Non-goals

Create a tool-agnostic canonical engineering section, document source and dependency boundaries, define testing and contract-evolution expectations, add deterministic documentation/repository consistency checks, strengthen contributor entry points, and inventory the governed documentation corpus.

Preserve the existing DOCS-001 static explorer, diagrams, source evidence, and business-facing documentation. Preserve valuable historical records and links rather than bulk-deleting or rewriting them. Runtime behavior, APIs, schemas, migrations, CLI behavior, provider/channel integrations, and production dependencies are unchanged.

## Acceptance Criteria

1. One indexed engineering section covers source organization, coding, architecture, testing, dependencies, APIs, errors/observability, configuration/secrets, persistence/migrations, performance, and documentation governance.
2. Each policy distinguishes mechanical checks, review rules, and recommendations and links to concrete repository ownership or enforcement.
3. Documentation taxonomy, authority precedence, ADR lifecycle, plan lifecycle, and historical-document handling are explicit.
4. Deterministic checks validate engineering completeness, lifecycle metadata, current architecture indexes, canonical repository identity, and links.
5. CI runs the documentation check independently from source-architecture checks.
6. CONTRIBUTING.md, README.md, and docs indexes provide accurate contributor and engineering entry points and an explicit validation matrix.
7. Every governed architecture, implementation, feature, decision, and plan record has an inventory classification and intended action.
8. DOCS-001 remains intact, discoverable, reproducible, and correctly marked completed.
9. Existing runtime and product behavior is unaffected; all relevant documentation and architecture checks pass.

## Technical Approach

1. Add concise policy documents under docs/engineering, deriving rules from current source layout, scripts, accepted decisions, and existing constitution while keeping factory-specific mechanics linked but non-authoritative.
2. Extend scripts/check_documentation.py and focused tests to enforce deterministic policy completeness, lifecycle metadata, taxonomy/index constraints, and repository identity. Add npm and CI entry points.
3. Rewrite contributor guidance and link it from existing user-facing indexes without displacing DOCS-001.
4. Generate a machine-readable inventory for all governed records. Treat the curated architecture index as current authority; retain unindexed prompts, plans, audits, reviews, validations, and handoffs as context-only history to avoid destructive moves and broken links.
5. Run focused checks, factory verification, and one autoreview pass; record acceptance-criterion evidence.

The simpler rejected approach was bulk-moving every historical architecture file. That would create broad link churn and risk history loss without improving authority: a curated current index plus complete inventory makes lifecycle explicit with a smaller, safer diff.

## Decisions

No new decisions. This work documents and enforces existing repository, authority, storage, provider-boundary, and DOCS-001 decisions without changing product architecture.

## Surface Impact

| Surface          | Status              | Reason                                                                                 |
| ---------------- | ------------------- | -------------------------------------------------------------------------------------- |
| Runtime behavior | Unchanged by design | Documentation governance does not alter execution.                                     |
| API              | Unchanged by design | No endpoint or contract changes.                                                       |
| Data/schema      | Unchanged by design | No migration or persistence changes.                                                   |
| CLI/ops          | Unchanged by design | Existing commands remain unchanged; only documented validation entry points are added. |
| UI               | Unchanged by design | The DOCS-001 static explorer and diagrams are preserved.                               |
| Docs             | Changed             | Canonical policies, indexes, contributor guidance, and inventory are added.            |
| Tests            | Changed             | Focused deterministic documentation-governance checks are added.                       |

## Task Decomposition

1. Publish the canonical engineering contract.
2. Enforce documentation governance deterministically.
3. Make contributor and repository entry points authoritative.
4. Classify and reconcile the documentation corpus while preserving history.
5. Produce criterion-to-proof closeout evidence and run final gates.

Each task directly serves acceptance criteria 1–9; no speculative runtime work is included.

## Risks

- Historical documents may be mistaken for current truth. Mitigation: curated index, explicit context-only classification, and inventory.
- Bulk relocation could break links or erase context. Mitigation: retain records in place unless a link-preserving migration is independently justified.
- Policy could drift into harness-specific instructions. Mitigation: define outcomes in engineering docs and link tools only as enforcement examples.
- The branch could overwrite DOCS-001. Mitigation: treat its explorer, atlas, evidence, and promotional content as immutable baseline except lifecycle/index links.

Tripwire: if review requires runtime, schema, public API, or broad historical relocation changes, stop and split that work into a separate issue.

## Verify Plan

- npm run docs:check
- npm run check:architecture
- npm run format:check
- python3 -m unittest scripts.test_check_documentation
- git diff --check
- python3 factory/scripts/verify.py
- autoreview --mode branch against the DOCS-001 base
