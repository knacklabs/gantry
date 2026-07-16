# 2026-05-20 — Simple Permission And Job Tool Lifecycle

## Context

Scheduler jobs used `requiredTools` for two different meanings: access needed
before a run and post-run evidence that each tool was used. That confused
agents and users. A job that had browser access could still fail because it did
not browse, even when browsing was only an available capability. Permission
prompts also mixed transient and durable readiness choices in setup flows.

## Decision

Jobs declare `accessRequirements` only. An Access Requirement is a preflight
readiness assertion inherited from the target agent capability set. It can name
a reviewed capability id, a selected MCP source, or a scoped `RunCommand(...)`
fallback. If any requirement is missing, setup pauses with one clear recovery
action. A successful run is not checked afterward for whether every requirement
was used.

A Transient Approval is run-local permission such as `Allow once`.

A Persistent Grant is durable selected authority for future runs, such as
`browser.use`, `FileRead`, `WebRead`, `capability:<id>`, an exact
`mcp__gantry__<admin_tool>`, or a scoped `RunCommand(...)` rule. Permission
prompts show only `Allow once`, `Allow for future` when a persistent suggestion
exists, and `Cancel` where applicable.

Revocation is agent-owned. `admin_permission_revoke` disables the current
agent's selected tool binding, mirrors `settings.yaml`, removes same-run live
approval for future calls, and audits the decision. It cannot revoke another
agent's grant.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Scheduler preflight pauses missing access and no longer performs post-run must-use checks. |
| `settings.yaml` | Changed | Persistent revoke mirrors removal of readable agent tool rules. |
| Postgres/runtime projection | Changed | Job target metadata stores normalized `access_requirements`; private runtime split fields are derived projections. |
| Control API | Changed | Job create/update accepts `accessRequirements` and rejects old `requiredTools` inputs. |
| SDK/contracts | Changed | Public job shape uses `accessRequirements`. |
| CLI | Changed | Job rendering and mutation surfaces use `accessRequirements`. |
| Gantry MCP tools/admin skill | Changed | Scheduler tools use `access_requirements`; `admin_permission_revoke` performs a real revoke. |
| Channel/provider adapters | Changed | Prompt rendering offers one-shot approval, persistent approval when available, or cancellation. |
| Docs/prompts | Changed | Scheduler and permission docs define access-only requirements and the current approval choices. |
| Audit/events | Changed | Revocation records a permission decision; post-run must-use events are removed. |
| Tests/verification | Changed | Unit tests cover access-only jobs, setup prompt choices, revoke rollback, and migration registration. |

## Consequences

Agents do not need to self-edit a job to avoid unused-tool failures. They should
declare access needed for the work, request missing access through the product
permission flow, and use tools only when the task requires them.

Old `requiredTools`, `required_tools`, `toolAccessRequirements`,
`capabilityRequirements`, and `requiredMcpServers` inputs are rejected after the
clean cut. They remain only in migration SQL, private derived runtime fields, and
explicit stale-field rejection messages.

## Migration 0071 Operator Note

Migration `0071_jobs_target_workspace_key_cutover.sql` is an intentional hard
cutover for job execution scope naming. It refuses to run when any existing job
payload still contains the former execution-scope field names.

Before applying the migration in an environment with existing jobs:

- Run the migration in a maintenance window.
- If it fails on the stale-shape guard, use the guard predicate in that
  migration file to list affected job ids.
- Recreate those jobs through the current API or CLI so their execution context
  uses `workspaceKey`, then re-run migrations.
- Do not add runtime readers, aliases, or automatic repair for the old shape.
