# AI employee V1 — developer handover

**Goal.** Make "Onboard AI employees like real ones" true: an IT admin gives an
agent a seat in Teams or Slack, only the access it needs, a full audit trail,
and offboards it in one command; self-hosted, any model. V1.0 is everything
visible in a three-minute real-product video (onboard → scope → approve via
Adaptive Card → offboard in a real Teams tenant). Nothing here is implemented;
this is the planning handover.

**Read first (in order):** `AGENTS.md` → `docs/product/BRIEF.md` (Positioning
Rules) → the spec for your story → the decisions it cites →
`docs/architecture/ai-employee-v1-gap-analysis.md` (what Codex found in the
code that the story must respect).

## Milestones and stories

| Milestone | Story | Title | Skill | Depends on | Spec |
|---|---|---|---|---|---|
| V1.0 | `IDENT-2` | Agent identity: agents as principals | backend | — | `docs/specs/agent-identity-and-offboarding.md` |
| V1.0 | `PKG-1` | npm packaging and self-serve install | backend | — | `docs/specs/self-serve-install-and-docs.md` |
| V1.0 | `RBAC-1` | Roles for people and agents | backend | IDENT-2 | `docs/specs/approvals-and-roles.md` |
| V1.0 | `HITL-1` | In-chat approvals as principals | fullstack | IDENT-2, AUDIT-1, TEAMS-1 | `docs/specs/approvals-and-roles.md` |
| V1.0 | `DIR-UI-1` | Directory UI: agents, access, audit, offboard | frontend | IDENT-2, UIFACADE-1 | `docs/specs/ai-employee-directory.md` |
| V1.0 | `DOCS-1` | Onboard/access/audit/offboard documentation spine | fullstack | — | `docs/specs/self-serve-install-and-docs.md` |
| V1.0 | `IDENT-4` | Person offboarding | backend | IDENT-2 | `docs/specs/agent-identity-and-offboarding.md` |
| V1.0 | `TEAMS-E2E-1` | Teams real-tenant agent-e2e | backend | TEAMS-1, IDENT-2 | `docs/specs/teams-channel.md` |
| V1.0 | `TEAMS-1` | Teams transport: Bot Framework, manifest, endpoint | backend | — | `docs/specs/teams-channel.md` |
| V1.0 | `AUDIT-1` | Audit actor migration matrix to PrincipalRef | backend | IDENT-2 | `docs/specs/agent-identity-and-offboarding.md` |
| V1.0 | `UIFACADE-1` | Browser facades: live agents and audit read models | fullstack | IDENT-2 | `docs/specs/ai-employee-directory.md` |
| V1.0.x | `CONN-GSUITE-1` | Google Workspace connector | backend | CONN-1, OAUTH-1 | `docs/specs/connector-accounts.md` |
| V1.0.x | `CONN-1` | Connector Account platform | backend | — | `docs/specs/connector-accounts.md` |
| V1.0.x | `COST-1` | Per-agent usage view | fullstack | UIFACADE-1 | `docs/specs/ai-employee-directory.md` |
| V1.0.x | `SOV-1` | Sovereign mode: generic OpenAI-compatible provider and no-egress check | backend | EGRESS-1 | `docs/specs/sovereign-mode.md` |
| V1.0.x | `OAUTH-1` | Connector OAuth platform | backend | CONN-1 | `docs/specs/connector-accounts.md` |
| V1.0.x | `EGRESS-1` | Host-owned egress allowlist | backend | — | `docs/specs/sovereign-mode.md` |
| V1.1 | `IDENT-3` | Phone-number alias kind | backend | IDENT-2 | `docs/specs/phone-channels-and-cost-cap.md` |
| V1.1 | `WA-1` | WhatsApp provider | backend | IDENT-3 | `docs/specs/phone-channels-and-cost-cap.md` |
| V1.1 | `VOICE-1` | Voice provider adapter | backend | IDENT-2, IDENT-3 | `docs/specs/phone-channels-and-cost-cap.md` |
| V1.1 | `COST-2` | Per-agent hard monthly token cap | backend | COST-1 | `docs/specs/phone-channels-and-cost-cap.md` |

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

## Working rules

- Every story is bounded and capability-driven; the spec is the contract, the
  story's acceptance criteria are the test list.
- Vocabulary: "agent" in code, CLI, API; "AI employee" only on the landing page
  and as the directory heading.
- Agent-to-agent channel messaging stays off; in-runtime delegation is fine.
- Offboarding is administrator-only and irreversible; retired aliases never revive.
- Implementer writes and records tests; one autoreview pass; functional check for
  user-facing stories (DIR-UI-1, HITL-1, TEAMS-1, DOCS-1, PKG-1).
