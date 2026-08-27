# MCP agent attachments design

## Summary

An MCP server is a reviewed source; attaching it makes its tools visible to an
agent for future runs, while separately configured capabilities remain the only
durable authority to act.

The MCP detail page is the primary, server-centric place to manage which agents
are attached. The Agent Access page remains the agent-centric alternative.

## Exact UX contract

### MCP detail page

Replace the current single-agent attach form with an `Attached agents` panel.

- Title: `Attached agents`
- Description: `Connected sources make MCP tools visible. They do not grant authority to act.`
- Header action: `Attach agents`
- The list has a bounded height and internal scrolling.
- Each row shows the agent name, `Source attached`, `Open agent`, and `Detach`.
- Empty state: `No agents are attached to this MCP server.`

Only an active and ready MCP server can show an enabled `Attach agents` action.
For other lifecycle states, show the existing lifecycle reason and no attach
control. Disabled or credential-missing servers are never attachable as
"pending" sources.

### Attach agents dialog

- Title: `Attach agents`
- Subtitle: `Choose active agents that can use this reviewed source. This does not grant actions.`
- Search placeholder: `Search agents by name...`
- The table is paginated and independently scrollable.
- Selection persists while changing pages or searching.
- Existing bindings show `Attached` and cannot be selected.
- Disabled agents show `Unavailable` and their reason; they cannot be selected.
- Footer: `Cancel` and `Attach N agents`.
- The selection uses the reviewed server scope as-is. It exposes no advanced
  binding controls, tool-pattern narrowing, or required-at-startup controls.

On success, close the dialog, refetch the server detail and navigation summary,
and show: `MCP source attached. It becomes available on each agent’s next run.`

### Detach

`Detach` opens a confirmation:

- Title: `Detach <server> from <agent>?`
- Body: `This removes the source from future runs. Existing capability policy is unchanged.`
- Actions: `Cancel` and `Detach source`

Successful detach refetches the detail and navigation summary and shows:
`MCP source detached.`

## Implementation changes

Retain the existing single-agent control API and browser routes for backwards
compatibility with CLI and management clients. Add browser-only bulk surfaces:

- `GET /ui/api/mcp-servers/:serverId/eligible-agents?q=&page=&pageSize=`
  returns a page of active agents, their attachment state, and total count.
- `PUT /ui/api/mcp-servers/:serverId/agents` with `{ "agentIds": [...] }`
  validates every selected agent before changing state, attaches all in one
  transaction, synchronizes the settings projection once, and returns the
  attached count.

The endpoint rejects an inactive/non-ready server, disabled/nonexistent agents,
already-attached agents supplied as new selections, duplicate IDs, an empty
selection, and an unauthorized browser session. A failed validation creates no
bindings. Existing attachment state is not silently remapped.

The bulk operation persists MCP-to-agent source bindings in Postgres. The
runtime projection is synchronized to `settings.yaml`, which remains the
restart source of truth for desired agent source bindings. Capability policy is
not read or written by this flow.

## Acceptance criteria

1. An administrator can search, paginate, select, and bulk attach eligible
   active agents from an active ready MCP detail page.
2. Every selected agent is attached or none are; the response includes the
   attached count and the page updates without reload.
3. Attached, disabled, and ineligible agents are clearly non-selectable with
   accurate labels.
4. Attach does not create or widen an agent capability grant.
5. Detach removes only that source binding and requires confirmation.
6. The detail list and dialog table remain usable with long agent lists.
7. Viewer sessions can read attachment state but cannot mutate it.

## Test plan

- Unit test request parsing, eligibility, deduplication, and all-or-nothing
  validation.
- Postgres integration test for bulk binding plus one settings projection sync;
  verify failed input leaves no binding behind.
- Browser route tests for authorization, pagination, and response shapes.
- Component tests for dialog selection across pages, disabled states, receipt,
  detach confirmation, and invalidation/refetch.
- Manual browser test with an active MCP and more agents than one page:
  attach, detach, refresh, then inspect the Agent Access view.

## Surface impact matrix

| Surface | Status | Impact |
| --- | --- | --- |
| Runtime behavior | Changed | Future-run source visibility follows the new bindings. |
| `settings.yaml` | Changed | Projection is synchronized once after a successful bulk mutation. |
| Postgres/runtime projection | Changed | Bulk source bindings are persisted atomically. |
| Control API | Unchanged by design | Existing single-agent API remains intact. |
| Browser control API | Changed | Adds eligible-agent listing and bulk attach routes. |
| SDK/contracts | Changed | Adds browser DTO/request validation only if shared contracts are required. |
| CLI | Unchanged by design | Existing single-agent commands retain their behavior. |
| Gantry MCP/admin skill | Unchanged by design | No new tool is required for this Web-only workflow. |
| Channel/provider adapters | Not applicable | Binding is provider-neutral source configuration. |
| Docs/prompts | Changed | This design documents the source-versus-capability boundary. |
| Audit/events | Read-only/observable | Existing settings/projection audit continues to reflect mutations. |
| Tests/verification | Changed | Adds focused API, persistence, component, and browser checks. |

## Locked decisions

- MCP detail is the primary server-centric attachment surface; Agent Access is
  the agent-centric alternative.
- Attaching a source does not grant capabilities or tool authority.
- Only ready active MCP servers and active eligible agents can be attached.
- Detach removes the source for future runs and does not alter capabilities.
- The normal Web flow has no advanced source-binding controls.
- The Web flow uses paginated reads and one atomic bulk write.
