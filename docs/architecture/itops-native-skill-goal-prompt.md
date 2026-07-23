# IT Ops Native Skill Goal

## Status

Native transport cutover completed locally on 2026-07-22. Plan validation was
completed against the Gantry and `ITOps.Agent` repositories before code
changes. The legacy IT Ops MCP is detached from `agent:itops` and disabled;
browser-connector replacement remains intentionally deferred behind parity.

## Objective

Move the existing IT Ops tool surface from the separately deployed IT Ops MCP
bridge into Gantry's host-owned tool facade. Preserve the existing IT Ops API,
database, connectors, workflows, validation, approvals, idempotency, audit
records, tool names, tool schemas, and deterministic user-facing responses.

The IT Ops tools must be mounted only when the current run has selected the
canonical `itops` skill. The IT Ops Slack conversation remains bound to the
`itops` agent. ATS and every other agent must not receive or invoke these tools.

## Non-goals

- Do not move IT Ops business data into the Gantry database.
- Do not reimplement onboarding, offboarding, access, approval, or connector
  business logic in Gantry.
- Do not change IT Ops system prompts or Slack response wording.
- Do not remove the current MCP source before native parity and live smoke tests
  pass.
- Do not replace the audited Slack browser task contract with free-form browser
  actions. A Gantry Browser adapter must preserve the same task state and result
  contract before the Playwright connector is retired.

## Architecture

```text
IT Ops Slack conversation
  -> Gantry IT Ops agent
  -> selected `itops` skill
  -> Gantry native IT Ops tools (skill-gated)
  -> IT Ops API
  -> IT Ops database and typed connectors
```

The copied tool adapter is transport-neutral despite being registered on
Gantry's internal runner facade. There is no separately configured or deployed
IT Ops MCP server, MCP URL, or MCP bearer token in the final state.

## Security Invariants

1. Native IT Ops tools are included in the model-visible tool allowlist only
   when a selected skill display has the exact canonical name `itops`.
2. The tool registrar repeats the same skill check and registers nothing when
   the skill is absent. Environment variables alone never enable the tools.
3. IT Ops API credentials remain host-projected values and are never included
   in tool output, logs, prompts, or errors.
4. The IT Ops API remains the sole owner of policy, approval, lifecycle,
   connector execution, idempotency, and business audit state.
5. The existing conversation-to-agent binding remains a second isolation
   boundary; skill gating does not rely only on the Slack trigger name.

## Delivery Stages

1. Freeze the existing 39-tool inventory and formatter behavior with parity
   tests.
2. Copy the thin client, schemas, formatters, and audit wrapper into Gantry and
   remove only NestJS and external MCP transport construction.
3. Add the 39 tool names to Gantry's internal allowlist only for runs selecting
   `itops`, and register their unchanged handlers only under the same condition.
4. Project only the IT Ops API URL, timeout/retry settings, and optional API key
   into Gantry's internal tool process.
5. Build and run unit/type tests, then smoke the native path while the old MCP
   source is still available for rollback.
6. Remove the IT Ops MCP source from only the `itops` agent after parity passes.
   Completed locally; the catalog definition is disabled for audit history.
7. Add a Gantry Browser-backed Slack connector adapter that keeps the existing
   audited task contract; retire the Playwright implementation only after its
   connector parity tests and live smoke pass.
8. Package the IT Ops API into the Gantry deployment unit while preserving a
   separate IT Ops database and health checks. Completed for the local fleet
   Compose rehearsal; production ECS wiring remains deployment-specific.

## Cutover And Rollback

Cutover is ordered so transport removal is last. Before cutover, compare native
tool inventory against the bridge inventory, exercise representative read and
mutation workflows, and verify ATS cannot list IT Ops tools. If any parity or
live check fails, leave the existing MCP source attached and disable the native
feature flag; no business-state rollback is required because both transports
call the same idempotent API.

## Surface Impact Matrix

| Surface | Classification | Detail |
| --- | --- | --- |
| Runtime behavior | Changed | Skill-selected runs can mount host-owned IT Ops tools. |
| `settings.yaml` | Changed at cutover | IT Ops MCP source removed; IT Ops skill, Browser capability, and conversation binding retained. |
| Postgres/runtime projection | Read-only/observable | Existing selected skill IDs/displays drive registration; no Gantry schema change. |
| Control API | Unchanged by design | No new control-plane endpoint is needed. |
| SDK/contracts | Unchanged by design | Existing runner tool protocol is reused. |
| CLI | Unchanged by design | Existing skill and access management remain authoritative. |
| Gantry MCP tools/admin skill | Changed | Adds skill-gated native IT Ops tool definitions to Gantry's internal facade; removes external IT Ops MCP dependency. |
| Channel/provider adapters | Unchanged by design | Slack routing, threading, triggers, and provider accounts remain unchanged. |
| IT Ops API/business logic | Unchanged by design | The API remains the system of record and workflow executor. |
| Connector/browser execution | Deferred | Gantry Browser replacement requires a parity-preserving adapter, not a free-form prompt change. |
| Deployment | Changed | Fleet Compose bundles the API and separate IT Ops database; ECS uses the documented private service or sidecar shape. |
| Docs/prompts | Changed | Update migration, operations, deployment, and skill usage documentation; preserve prompt semantics. |
| Audit/events | Unchanged by design | Business audit remains in IT Ops; the thin tool-call audit is retained with a native transport label. |
| Tests/verification | Changed | Add inventory, isolation, projection, registration, response parity, and live smoke coverage. |

## Plan Validation Findings

- Command-template skill actions are not viable because Gantry direct mode does
  not mount `RunCommand`; host-owned typed tools are required.
- A generic single `itops_call_tool` would weaken schema discovery and change
  model behavior; all existing named tools must remain named and typed.
- Hard-coding one installed skill UUID would break reinstall/deployment. The
  gate must use the canonical selected skill display name and exact parsing.
- API environment availability is not authority. Tool allowlisting and handler
  registration both need the skill gate.
- Immediate free-form browser replacement would weaken deterministic retries,
  task persistence, and auditing. Preserve the connector contract first.
- The old MCP source must remain until the native inventory, behavior, and
  isolation checks pass, then be removed as the final reversible cutover step.

These findings are incorporated into the delivery stages and security
invariants above; no unresolved behavior or security decision remains for the
native transport stage.
