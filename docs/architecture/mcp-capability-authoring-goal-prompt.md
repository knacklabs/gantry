# MCP capability authoring — goal prompt

Status: DESIGN LOCKED 2026-07-21 (user: "agent proposes → human approves").
Lands ON develop as part of PR #237 (depends on R5's `mcp_pattern` single
action authority; it is the missing link that lets the agent-driven
acquisition e2e pass, so it gates #237's merge).

## The gap this closes

Skills close the acquisition loop because the skill manifest AUTHORS its
capability definitions (`skill-action-permissions.ts` →
`SemanticCapabilityDefinition` with `RunCommand(template)` bindings, persisted
at install), so `request_access target.kind=capability` has a definition to
reference. MCP has NO equivalent: nothing turns a connected server's tools
into a reviewed `mcp_pattern` definition, so for a freshly-connected server
`request_access` errors "No reviewed capability matches id"
(`runner/mcp/tools/capabilities.ts:129-141`). Install → approve-specific-tools
→ call is unreachable without out-of-band catalog seeding.

## Design (locked)

The MCP analog of the skill manifest is the AGENT'S REQUEST. The agent, after
connecting a server (inventory-only, existing) and reading its inventory
(`mcp_list_tools`/`mcp_search_tools`, existing), REQUESTS a reviewed capability
over specific tools. The HUMAN APPROVAL is what creates the reviewed
definition — the agent never writes to the catalog. This preserves the R5
invariant "agents cannot author capability definitions"
(`ipc-admin-handlers.ts:435`, `request-permission-review.ts:349-360`): the
agent submits a REQUEST; host code, triggered by a human approve decision,
persists the definition.

### Request shape

New requestable target (extend `request_access`, e.g.
`target.kind: 'mcp_capability'`) carrying:

- `serverName` (or serverId) of an ACTIVE agent-bound MCP source,
- `tools`: exact tool names and/or trailing-star patterns to include,
- `risk`: `read` | `write` (agent proposes; human confirms — shown in prompt),
- `displayName` + `reason`.

### Candidate synthesis (host-side, pre-approval)

Build a CANDIDATE `SemanticCapabilityDefinition` with a single `mcp_pattern`
implementation binding (`server`, `patterns`) — never persisted yet. Validate:

1. the server is an ACTIVE agent source binding
   (`authorizedMcpServerIdsForAgent`);
2. every requested tool/pattern is WITHIN the server's connect-time reviewed
   source scope (`allowedToolPatterns`) — reject via the R5 scope logic
   (`mcp-tool-scope.ts` `normalizeMcpToolScope` throws if scope exceeds); an
   agent can never request tools the server wasn't connected with;
3. patterns pass `mcp_pattern` validation
   (`semantic-capabilities.ts:376-427`): exact names or trailing-star globs;
4. optionally: cross-check each requested name exists in current inventory
   (warn, don't hard-fail — inventory drifts).

The host derives the candidate capability id from the normalized server, risk,
and reviewed pattern set. The agent does not propose the id. For wildcard
requests, review shows both the reviewed patterns and every exact tool name that
can be resolved from the connected source scope; an unresolved wildcard remains
visible as a pattern and is never silently widened.

### Human approval prompt

Post the SAME same-channel human-approver prompt the other capability requests
use (`startRequestOnlyCapabilityReview` / `request-permission-review.ts`),
`decisionOptions ['allow_once','allow_persistent_rule','cancel']`. The prompt
MUST show: server name, the EXACT tool list (resolved), and the read/write
class — so the approver reviews the concrete footprint (parity with the skill
prompt showing files + commands). `allow_once` does NOT create a durable
definition (consistent with R5 — live rules can't mint MCP action authority);
only `allow_persistent_rule` classified `user_permanent` persists.

### On approve (host-side write)

On a human `allow_persistent_rule` decision:

1. Persist the `mcp_pattern` `SemanticCapabilityDefinition` to the reviewed
   catalog (`ensureAgentToolCatalogItem` path) with the confirmed risk class.
2. Grant it to the agent through the EXISTING durable path
   (`PermissionManagementService.applyPersistentToolRuleGrant` +
   `ensureMcpSourceBindingsForRules`), so the agent tool binding + narrowed
   source binding are written exactly as for a pre-seeded capability.
3. R5 pattern∩source-scope intersection then governs every call
   (`mcp-tool-proxy-capabilities.ts` `intersectMcpToolRulesWithSourceScopes`)
   — the new definition can never exceed the connected source scope even if
   inventory later grows.

Read-risk definitions feed the deterministic read-only auto-permission gate
(`agent-tool-runtime-rules.ts:45-73`); write-risk stays prompt-gated. That IS
the read/write separation, now reachable for agent-connected servers.

## Security invariants (must hold; pin each)

- Agent proposal is a REQUEST, not a write; only human approval persists the
  definition. No agent-supplied definition path is added.
- Requested tools OUTSIDE the server's connect-time source scope are REJECTED
  before the prompt (never approvable).
- `allow_once` never creates a durable definition or callable MCP authority.
- The persisted binding is `mcp_pattern` (never legacy `mcp_tool`).
- A locked/fixed-image agent cannot reach the request (existing profile gate).
- Non-approver conversation members cannot approve (existing
  `authorizeConversationApprover`).

## Tests (behavioral, pin every invariant)

- Integration: connect fixture server (source-scope `get-sum`,`echo`) → agent
  requests `mcp_capability` over `get-sum` as `read` → human approve →
  reviewed `mcp_pattern` definition persisted + granted → `mcp_call_tool
get-sum` now authorized; a request including `search_delete` (outside source
  scope) is REJECTED before any prompt; `allow_once` leaves the call denied;
  deny leaves nothing persisted; the persisted binding kind is `mcp_pattern`.
- Reuse the mcp-client-loop / permission-durable-authority harness patterns.

## E2E follow-on (unblocks the tool-loop scenario)

With this, the matrix §5 agent-driven acquisition rows become buildable:
connect (API) → agent requests capability → approve (channel button, or the
`approvals:write` interaction-response API once develop pulls main's #252) →
follow-up turn calls the fixture tool with recorded args. Build that scenario
after this lands (it is the composed proof that was blocked).

## Non-goals

- No admin pre-authored reusable named capabilities (deferred — user chose
  agent-proposed synthesis; curation is a later follow-up).
- No change to the reviewed-approval flow itself or to skills.
- No new authority semantics — this only creates definitions the existing
  single-authority model already knows how to enforce.

## Surface Impact Matrix

| Surface                      | Impact               | Reason                                                                                                                                                    |
| ---------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed              | `request_access` can submit an MCP capability proposal; host validation and permanent human approval create the reviewed definition and grant.            |
| `settings.yaml`              | Unchanged by design  | The existing persistent-grant mirror records the selected capability; no new settings field or parser is added.                                           |
| Postgres/runtime projection  | Changed              | Existing tool-catalog, agent-tool-binding, and MCP source-binding repositories persist the approved definition and selection; no schema change is needed. |
| Control API                  | Unchanged by design  | No admin pre-authoring or new route is part of this goal.                                                                                                 |
| SDK/contracts                | Unchanged by design  | The request is an existing Gantry MCP tool schema, not a Control API contract.                                                                            |
| CLI                          | Unchanged by design  | No CLI pre-authoring surface is added.                                                                                                                    |
| Gantry MCP tools/admin skill | Changed              | `request_access` gains `target.kind=mcp_capability`.                                                                                                      |
| Channel/provider adapters    | Read-only/observable | Existing channel-neutral same-channel approval rendering displays the added server, patterns/tools, and risk details.                                     |
| Docs/prompts                 | Changed              | This goal prompt records the request and approval contract.                                                                                               |
| Audit/events                 | Read-only/observable | Existing permission and MCP binding audit paths record the permanent decision and grant.                                                                  |
| Tests/verification           | Changed              | Runner, handler, persistence, scope, prompt, and proxy-call behavioral tests pin the security invariants.                                                 |
