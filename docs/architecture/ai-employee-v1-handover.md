# AI employee V1 — developer handover

**Goal.** Make "Onboard AI employees like real ones" true: an IT admin gives an
agent a seat in Teams or Slack, only the access it needs, a full audit trail,
and offboards it in one command; self-hosted, any model. V1.0 is everything
visible in a three-minute real-product video (onboard → scope → approve via
Adaptive Card → offboard in a real Teams tenant). Nothing here is implemented;
this is the planning handover.

**Rendered roadmap (same content, scannable):** https://claude.ai/code/artifact/549cb1c9-a199-43c6-b1a9-580f1620a693

**Read first (in order):** `AGENTS.md` → `docs/product/BRIEF.md` (Positioning
Rules) → the spec for your story → the decisions it cites →
`docs/architecture/ai-employee-v1-gap-analysis.md` (what Codex found in the
code that the story must respect).

## Milestones and stories

| Milestone | Story | Title | Skill | Depends on | Spec |
|---|---|---|---|---|---|
| V1.0 | `IDENT-2` | Agent identity: agents as principals | backend | — | `docs/specs/agent-identity-and-offboarding.md` |
| V1.0 | `PKG-1` | npm packaging and self-serve install | backend | — | `docs/specs/self-serve-install-and-docs.md` |
| V1.0 | `RBAC-1` | Roles for people and agents | fullstack | IDENT-2 | `docs/specs/approvals-and-roles.md` |
| V1.0 | `HITL-1` | In-chat approvals as principals | fullstack | IDENT-2, AUDIT-1, TEAMS-1 | `docs/specs/approvals-and-roles.md` |
| V1.0 | `DIR-UI-1` | Directory UI: one list for people and AI employees, detail, offboard | frontend | IDENT-2, UIFACADE-1, DESIGN-1 | `docs/specs/ai-employee-directory.md` |
| V1.0 | `DOCS-1` | Onboard/access/audit/offboard documentation spine | fullstack | — | `docs/specs/self-serve-install-and-docs.md` |
| V1.0 | `IDENT-4` | Person offboarding | backend | IDENT-2 | `docs/specs/agent-identity-and-offboarding.md` |
| V1.0 | `TEAMS-E2E-1` | Teams real-tenant agent-e2e | backend | TEAMS-1, IDENT-2 | `docs/specs/teams-channel.md` |
| V1.0 | `TEAMS-1` | Teams transport: Bot Framework, manifest, endpoint | backend | — | `docs/specs/teams-channel.md` |
| V1.0 | `AUDIT-1` | Audit actor migration matrix to PrincipalRef | backend | IDENT-2 | `docs/specs/agent-identity-and-offboarding.md` |
| V1.0 | `UIFACADE-1` | Browser facades: live agents and audit read models | fullstack | IDENT-2 | `docs/specs/ai-employee-directory.md` |
| V1.0 | `ONBOARD-UI-1` | Onboarding wizard: create agent, seat, scope, approvers | fullstack | UIFACADE-1, IDENT-2, TEAMS-1, DESIGN-1 | `docs/specs/console-ai-employee-management.md` |
| V1.0 | `PEOPLE-UI-1` | People in the Directory: detail, aliases, offboard | fullstack | UIFACADE-1, IDENT-4 | `docs/specs/console-ai-employee-management.md` |
| V1.0 | `DESIGN-1` | Console design pass: directory, detail, wizard, people, handoffs | frontend | — | `docs/specs/console-ai-employee-management.md` |
| V1.0.x | `CONN-GSUITE-1` | Google Workspace connector | backend | CONN-1, OAUTH-1 | `docs/specs/connector-accounts.md` |
| V1.0.x | `IDENT-3` | Phone-number alias kind | backend | IDENT-2 | `docs/specs/phone-channels-and-cost-cap.md` |
| V1.0.x | `WA-1` | WhatsApp provider | backend | IDENT-3 | `docs/specs/phone-channels-and-cost-cap.md` |
| V1.0.x | `CONN-1` | Connector Account platform | backend | — | `docs/specs/connector-accounts.md` |
| V1.0.x | `COST-1` | Per-agent usage view | fullstack | UIFACADE-1 | `docs/specs/ai-employee-directory.md` |
| V1.0.x | `SOV-1` | Sovereign mode: generic OpenAI-compatible provider and no-egress check | backend | EGRESS-1 | `docs/specs/sovereign-mode.md` |
| V1.0.x | `OAUTH-1` | Connector OAuth platform | backend | CONN-1 | `docs/specs/connector-accounts.md` |
| V1.0.x | `EGRESS-1` | Host-owned egress allowlist | fullstack | — | `docs/specs/sovereign-mode.md` |
| V1.0.x | `UI-CONN-ACCOUNTS-1` | Connector Accounts page: add, connect OAuth, health, revoke | fullstack | CONN-1, OAUTH-1 | `docs/specs/console-ai-employee-management.md` |
| V1.0.x | `ACCESS-UI-1` | Access editor: preset, tool rules, capability grants | fullstack | DIR-UI-1 | `docs/specs/console-ai-employee-management.md` |
| V1.0.x | `HANDOFF-1` | Customer handoff to a human agent | fullstack | WA-1, HITL-1 | `docs/specs/phone-channels-and-cost-cap.md` |
| V1.0.x | `MODEL-1` | Per-agent model allowlist enforced at the gateway | backend | SOV-1 | `docs/specs/model-governance.md` |
| V1.0.x | `GUARD-1` | Pre-model guardrail hook with built-in PII and secret redaction | backend | AUDIT-1 | `docs/specs/model-governance.md` |
| V1.1 | `VOICE-1` | Voice provider adapter | backend | IDENT-2, IDENT-3 | `docs/specs/phone-channels-and-cost-cap.md` |
| V1.1 | `COST-2` | Per-agent hard monthly token cap | backend | COST-1 | `docs/specs/phone-channels-and-cost-cap.md` |
| V1.1 | `REPORT-1` | Per-agent reports and exports | fullstack | UIFACADE-1, AUDIT-1 | `docs/specs/ai-employee-directory.md` |

Entry points with no dependencies today: **IDENT-2** (unblocks 12), **TEAMS-1**,
**CONN-1**, **EGRESS-1**, PKG-1, DOCS-1. Run `./forge roadmap parallel` for the
current fan-out; one worktree per story.

## Decisions that bind this work

| Decision | Binds |
|---|---|
| 0136 voice-as-provider-adapter | VOICE-1 is an adapter after identity; never a runtime |
| 0137 connector-accounts-mirror-provider-accounts (+ rule 8) | CONN-1 shape; account provisions its MCP binding |
| 0138 agents-are-service-kind-persons | agent = `kind: service` Person; one offboard path |
| 0139 openai-compatible-model-provider | the single generic provider SOV-1 may add |
| 0140 two-tier-agent-e2e-gate | fixture tier blocks PRs; real tenant is the release bar |
| 0141 sandboxed-stdio-mcp-for-connectors | connector processes: sandboxed stdio under a supervisor |
| 0142 third-console-role-approver | administrator / approver / viewer; amends 0132 |
| 0143 browser-write-only-secret-ingest | browser submits secrets once, gets a reference back; never reads one |
| 0025, 0016, 0118, 0132, 0135, 0101, 0024, 0033, 0044 | pre-existing; cited inside the specs |

## Facts from the code you must not re-discover

- Teams transport is a stub (`apps/core/src/channels/teams-sdk-client.ts` returns
  `null`). TEAMS-1 is the first real Teams work.
- Shipped identity schema is `users` + `user_aliases(provider, providerAccountId,
  externalUserId)`; IDENT-2 is a migration from that, not from the documented tuple.
- Provider Accounts and installs are Postgres projections of revisioned desired
  state (ADR 0025). Atomic offboard = one revision + identity/runtime/outbox rows.
- Six persisted actor shapes across 103 writers. AUDIT-1 owns the matrix.
- `/agents` and Activity in the console are fixture-backed; `/v1/*` is Bearer-only.
  UIFACADE-1 adds the same-origin facades first.
- `conversation_approvers.external_user_id` is a raw provider id. DM self-approval
  already works.
- `/v1/usage` undercounts (memory extraction, dreaming, permission classifier).
  COST-1 is a labelled view; COST-2 fixes accounting before any hard cap.
- Egress is denylist/default-allow; `direct` mode advisory; remote MCP bypasses the
  runner proxy. EGRESS-1 is host-owned enforcement.
- `@gantry/runtime` is not on npm; no `dist/`, no `prepack`, no release workflow.
- PERM-2 (permission decision coordinator) is active and shares files with HITL-1.
- `/people`, `/agents`, `/activity` are previews; `/providers` and `/mcp-servers` are the live facade pattern to copy. Decision 0132 hard-codes two roles.
- A browser cannot create a Gantry-held secret today; 0143 adds the write-only ingest.

## Console coverage (added after the UI sweep)

Every lifecycle step has a browser surface: onboard (ONBOARD-UI-1), directory and
detail with pause/owner/approvers/offboard (DIR-UI-1 on UIFACADE-1), people and
human offboard (PEOPLE-UI-1), sign-in with Entra and roles (RBAC-1), audit
(activity facade), usage (COST-1), connector accounts with one-click OAuth
(UI-CONN-ACCOUNTS-1), access editing (ACCESS-UI-1), sovereign provider in the
existing providers page (SOV-1), effective egress policy read-only (EGRESS-1).
Console approvals of risky actions stay out of V1 by decision. The console is
Vitest-only today; user-facing stories need the functional checker (score ≥ 8).
Spec: `docs/specs/console-ai-employee-management.md`; sweep reports in the gap
analysis, Part 2.

## Customer support assistant (added 2026-08-26)

WhatsApp plus human handoff is the second proof, in V1.0.x: `IDENT-3` phone
identity → `WA-1` WhatsApp seat → `HANDOFF-1` handoff to a human in Teams/Slack.
Handoff is *not* approval: the human takes over the thread, the agent pauses in
that conversation only, every switch is audited. Meta business verification and
message templates are deployment prerequisites, not code. Voice and the hard cost
cap stay in V1.1.

## Console decisions (UI grill, 2026-08-26)

- **One Directory** for people and AI employees with a kind filter; `/agents` and
  `/people` previews are replaced, not extended.
- **Audit and Approvals tabs** are visible to administrators and approvers only;
  viewers see Overview and Access.
- **Handoffs** have a read-only console view; claiming stays in Teams/Slack.
- **DESIGN-1** runs first: one approved mockup canvas in the console's design
  system before DIR-UI-1 and ONBOARD-UI-1 are planned.
  Mockups (14 artboards, light/dark tweak, sample data):
  https://claude.ai/code/artifact/cbcf11f1-8bc2-4912-bb37-b2ea7c300010 — pending
  product-owner approval.

## Model governance and enterprise data (added 2026-08-26)

Compared against LiteLLM: Gantry is the runtime, not a gateway. Two additions
earn their place in V1.0.x — `MODEL-1` per-agent model allowlist enforced at the
gateway, and `GUARD-1` a pre-model guardrail hook with built-in PII/secret
redaction (no in-repo prompt-injection classifier). `COST-1` may show currency
via an imported open price table. `REPORT-1` (V1.1) covers reliability, access
changes, blocked actions, memory changes, audit export, SIEM sink, access-review
export, Prometheus. Rate limits ride with `COST-2`. Orgs with LiteLLM point the
`openai_compatible` provider at it. Spec: `docs/specs/model-governance.md`.

## Working rules

- Every story is bounded and capability-driven; the spec is the contract, the
  story's acceptance criteria are the test list.
- Vocabulary: "agent" in code, CLI, API; "AI employee" only on the landing page
  and as the directory heading.
- Agent-to-agent channel messaging stays off; in-runtime delegation is fine.
- Offboarding is administrator-only and irreversible; retired aliases never revive.
- Implementer writes and records tests; one autoreview pass; functional check for
  user-facing stories (DIR-UI-1, HITL-1, TEAMS-1, DOCS-1, PKG-1).
