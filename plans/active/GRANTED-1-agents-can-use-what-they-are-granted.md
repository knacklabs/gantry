---
issue: GRANTED-1
title: Agents can use what they are granted
status: awaiting-approval
saved: 2026-09-10T14:06:44+00:00
story: GRANTED-1
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
  - 0133-gantry-tool-correlation-response-meta
  - 0134-autonomous-compound-runcommand-leaf-authorization
  - 0135-browser-model-provider-credential-facade
  - 0136-voice-as-provider-adapter
  - 0137-connector-accounts-mirror-provider-accounts
  - 0138-agents-are-service-kind-persons
  - 0142-third-console-role-approver
  - 0143-browser-write-only-secret-ingest
  - 0144-autonomous-ask-and-wait-chat-parity
  - 0151-browser-navigation-summary
  - 0153-learned-decisions-project-into-job-grants
  - 0154-human-decision-memory-generic-scope
  - 0155-default-allow-gantry-tools-interactive-auto
  - 0156-ai-employee-console-resumable-deployment
  - 0157-jobs-use-the-chat-permission-ladder
  - 0158-granted-capabilities-must-be-discoverable
---

# GRANTED-1 — A granted capability is visible to the agent that holds it

## Problem

A scheduled run never receives a capability catalog, so an agent holding a
reviewed grant does not know it holds it. The KnackLabs lead-maintenance job
opened seven consecutive runs by burning failed calls before its first successful
sheet read: an invented MCP server, an invented tool, then off-template arguments.

The catalog is built only on the chat path
(`runtime/group-agent-access-context.ts:44`, consumed at
`runtime/group-agent-runner.ts:365`). The job path loads the access snapshot and
the semantic capabilities and then omits `capabilityCatalog` from its spawn input
(`jobs/execution-phases-run.ts:179` and `:287`), while prompt compilation renders
only what that input carries (`runtime/agent-spawn-prompt.ts:87`).

The dispatcher was always reachable: it is not in the set removed from autonomous
surfaces (`shared/admin-mcp-tools.ts:96`, filtered at
`runner/gantry-mcp-tool-surface.ts:152`), and the failing run's own fourth attempt
succeeded through it. The missing element is knowledge, not exposure. Commit
97ded3746 added a block to the runner's runtime capability context
(`runner/mcp/context.ts:412`); it deployed and changed nothing, because that is a
different surface from the catalog the model reads.

Spec: `docs/specs/granted-capability-is-visible.md` (confirmed).

## Scope / Non-goals

In: building the catalog on the job path from the person-filtered capability set,
a descriptor per usable binding kind, a shedding rule that never hides a grant,
an overflow diagnostic, deleting the superseded runtime-context block, and
pointing the dispatcher description at the catalog.

Out: any change to enforcement, the argv template, or the classifier; document
reading and editing, which moved to its own spec with decisions 0108 and 0114;
extending the catalog to the DeepAgents lane, which is follow-up.

## Owner rulings

- The reviewed argv template STAYS the enforcement boundary (0158); 0120 and 0130
  stand unamended.
- Reviewed argument shapes render exactly as reviewed. The owner was shown the
  tradeoff twice: a template may contain a fixed operand such as a config path,
  and it will appear in the prompt. Accepted, because those operands already
  appear on the approval card a human reviewed and are not credentials.
- Overflow always renders name and id; details degrade past a derived ceiling.
- The catalog carries a NEUTRAL tool reference and each lane translates it into
  its own tool name.
- The live five-run check is retained evidence, NOT a merge gate.
- Decision 0109's ordering consequence is amended so this ships first.

## Acceptance Criteria

1. A scheduled run's spawn input carries a capability catalog built from the
   person-filtered capability set, proven by a hermetic test over the real job
   execution path asserting the field is populated where it is absent today.
2. The catalog is built from `inheritedToolPolicy.semanticCapabilities`, not the
   broader snapshot set: a capability active for the app but not granted to the
   acting person never appears as ready. Asserted by a test with both sets
   differing.
3. The rendered guidance contains, for a granted capability, its display name,
   stable id, neutral tool reference and reviewed argument shape, asserted
   against the exact rendered text.
4. A descriptor is produced for each of the four usable binding kinds; the
   adapter reference never appears; an MCP pattern renders the proxy reference
   and server name; a skill action renders through its tool rule with 0129's
   terminal-wildcard semantics; a legacy `mcp_tool` binding still fails
   validation and never reaches the catalog.
5. The neutral tool reference resolves to the Anthropic runtime's tool name
   through an explicit mapping, asserted against the real projection
   (`adapters/llm/anthropic-claude-agent/runner/query-loop-phases-setup.ts:353`)
   for a scheduled run, including with tool search active. The mapping has one
   entry per lane and the DeepAgents entry is asserted absent, so its behaviour is
   unchanged and the gap is explicit rather than silent.
6. No grant is hidden. Material is shed in order: non-granted entries, then
   descriptions, then descriptors. The ceiling is derived as at least the compact
   representation of the granted set, so it cannot conflict with the never-hide
   rule. Asserted for a grant set large enough to exceed any fixed value.
7. The never-hide guarantee survives BOTH truncation points: the section budget
   (`application/agents/prompt-profile-service.ts:532`) and the total prompt
   budget (`:756`). The capability section is exempted from total-budget
   truncation below its compact representation, asserted end to end through
   prompt compilation rather than the renderer alone.
8. Overflow emits a run startup event carrying the granted count, the rendered
   count and the shedding stage reached, with no capability content in the
   payload. The renderer's existing callback propagates it to the run's startup
   diagnostic producer.
9. A deterministic replay builds its materialization through the production path,
   asserts the dispatcher is present in it, then drives the runner adapter with a
   named recorded fixture and a stub selecting only from that projection. Its
   first tool action is a well-formed dispatcher call with no preceding call to
   anything absent from the projection. A negative control removes the descriptor
   and asserts the same harness does not produce that call.
10. The per-capability block added by 97ded3746 no longer exists; the dispatcher
    description points at the catalog; its input schema, risk classification and
    host enforcement are pinned unchanged.
11. Enforcement is unchanged: a template mismatch is still refused, no
    classifier-derived or cached allow reaches the dispatcher, and executable
    identity, structured argv, size and NUL limits still apply. Existing proofs
    for 0120 and 0130 stay green.
12. No descriptor contains an executable path, a hash or a credential. Reviewed
    argument operands are permitted per the owner ruling; the executable itself,
    its hash and any credential are not. Asserted against a capability whose
    binding carries all three.
13. Live evidence, not a merge gate: five serial runs of
    `job-knacklabs-lead-maintenance-43527c192a6e`, existence verified first, each
    with at least one successful capability invocation and zero `tool.activity`
    rows with phase `failure` of ANY tool before it. Per-run event query and
    startup diagnostic retained redacted on the story.

## Technical Approach

**One builder, both lanes.** The job path calls the same catalog builder the chat
path uses (`runtime/group-run-context.ts:156`), feeding it
`inheritedToolPolicy.semanticCapabilities` from `jobs/execution-phases-run.ts:183`
rather than the broader snapshot set, and sets the existing `capabilityCatalog`
field on the spawn input. Feeding the broader set would advertise an app-active
but ungranted capability as ready, which is the security boundary this criterion
protects.

**Descriptor union.** `CatalogEntry`
(`application/agents/agent-prompt-capability-catalog.ts:23`) gains a closed
`invocation` union over the four usable implementation kinds
(`shared/semantic-capabilities.ts:25`; legacy `mcp_tool` is rejected at
validation): `local_cli` carries a neutral dispatcher reference, the capability id
and the reviewed argument patterns; `mcp_pattern` a neutral proxy reference and
the connected server name; `tool_rule` the tool name, including skill actions,
which are a tool rule distinguished by source; `adapter` the neutral dispatcher
reference and capability id. Skill actions are NOT a binding kind: that name
belongs to `CapabilityRuntimeAccessSourceType`, a different axis. The entry also
renders `stableRef`, which the renderer drops today.

**Neutral reference, per-lane translation.** The catalog stores a lane-independent
reference. A small mapping renders it into the Anthropic runtime's tool name at
prompt-compile time. The DeepAgents lane has no entry, so its rendering is
unchanged and the omission is asserted rather than implicit.

**Shedding and the two budgets.** A named default budget plus a derived ceiling
replaces the fixed 1,500 (`application/agents/prompt-profile-service.ts:54`).
Because compilation truncates twice, the capability section is exempted from
total-budget truncation below its compact representation, so a second cut cannot
sever an id the section guaranteed.

**Deletion and wording.** The 97ded3746 block leaves `runner/mcp/context.ts`; the
dispatcher description in `runner/mcp/tools/capability-run.ts` points at the
catalog. Schema, risk and enforcement pinned by test.

## Decisions

Governing: 0158, 0120, 0130, 0109 (ordering amended), 0129. No new decision.

## Surface Impact

- **Runtime / prompt:** the whole change. Scheduled spawn input, catalog entry
  shape, guidance renderer, budget constants, the lane mapping.
- **Data:** none. No migration, no schema change.
- **MCP / API:** the dispatcher description text only; schema, risk and
  enforcement pinned unchanged.
- **CLI / ops:** none. No command, flag or deploy step changes.
- **UI:** none. No screen, component or styling changes, hence
  `user_facing: false`.
- **Docs:** none beyond the confirmed spec and the amended decisions already
  committed.
- **Security:** neutral by construction and carried by enforcement-unchanged
  proofs, plus the person-filtered source in criterion 2 and the no-credential
  rule in criterion 12.
- **Tests:** named below.

## Task Decomposition

Single task. Write scope about 13 files: source —
`jobs/execution-phases-run.ts`, `runtime/group-run-context.ts`,
`application/agents/agent-prompt-capability-catalog.ts`,
`application/agents/agent-prompt-capability-guidance.ts`,
`application/agents/prompt-profile-service.ts`, `runner/mcp/context.ts`,
`runner/mcp/tools/capability-run.ts`; tests — the capability catalog, capability
guidance, prompt profile, agent spawn prompt, job execution phases, capability
structured invocation and locked introspection suites, plus a new replay suite.
Budget 13 files / 1,000 lines.

## Risks

- The shedding rule and the total-budget exemption change a shared compiler, so
  chat prompts change too. The named constants and the ordered shed keep that
  bounded and asserted end to end.
- The replay harness is the one genuinely new piece of test machinery; keep it a
  fixture-driven table, not a framework.
- Feeding the wrong capability set is the security risk in this change; criterion
  2 exists specifically to pin it.
- The live check is evidence, not a gate, so a flaky model turn cannot block a
  correct change.

## Verify Plan

The suites named above by file through `vitest.unit.config.ts`, then
`npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run check:architecture` and `verify.py` with `GANTRY_TEST_DATABASE_URL`.

After it lands and deploys, as evidence: five serial runs of
`job-knacklabs-lead-maintenance-43527c192a6e`, existence verified first, each
requiring at least one successful capability invocation and zero `tool.activity`
rows with phase `failure` of any tool before it, with the per-run event query and
the startup diagnostic retained redacted.
