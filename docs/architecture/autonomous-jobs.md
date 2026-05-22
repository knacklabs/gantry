# Autonomous Jobs

Autonomous jobs are runtime state, not desired-state configuration. Recurring,
one-time, and manually triggered scheduler jobs are stored in Postgres and must
not be written to `settings.yaml`.

## Capability Resolution

At execution time, a job resolves its target agent from the runtime target:
`group_scope` plus `execution_context` (`conversationJid`, optional `threadId`,
optional `sessionId`). The job inherits that target agent's currently selected
capabilities plus attached sources for the run. Job records do not carry
separate tool, skill, MCP, or capability grants.

Inherited tool grants are semantic capability entries such as
`capability:google.sheets.write`, canonical `Browser`, selected first-party
catalog tools, Gantry file/web facades such as `FileRead`, exact Gantry admin
tools, approved third-party MCP server bindings, or scoped command rules such as
`RunCommand(npm test *)`. Runtime expands semantic capabilities and may still
project approved third-party MCP server bindings into SDK allowances for that
run. Empty rules, global `*`, broad exact SDK/native request_permission grants,
exact third-party MCP tool grants, bare `Bash`, bare `RunCommand`, `Bash(*)`,
`RunCommand(*)`, leading-wildcard command scopes, private browser backend rules,
and projected browser gateway rules are invalid as persistent request_permission
authority.

Browser is one durable public capability: `Browser`. A job with an inherited
`Browser` grant receives the projected Gantry browser gateway for that run. A job
without that inherited grant must request `Browser` through `request_permission`;
it must not request or persist private browser backend names or projected
browser gateway tool names.

## Readiness Gates

Job create/update surfaces accept declared setup requirements:

- `toolAccessRequirements`: durable readable tool rules such as `Browser`,
  `capability:google.sheets.write`, exact Gantry file/web facades, exact
  first-party Gantry MCP tools, or scoped `RunCommand(...)` rules.
- `capabilityRequirements`: semantic capability requirements such as
  `google.sheets.write` or a reviewed composite capability such as
  `weekly.linkedin.report.publish`. Requirements are stored on the job and
  converted into readiness checks; they are not grants.
- `requiredMcpServers`: approved third-party MCP server names or ids expected
  by the job.

The declarations are UX assertions, not authorization. The runtime still
enforces actual tool use at the permission boundary, and under-declared jobs
pause if a run later reaches a denied tool.
Create/update surfaces validate these assertions up front. Unsupported raw
browser backend names, projected browser gateway names, Gantry wildcards, broad
or bare command grants, and unsupported scoped rules fail the request instead of
becoming compatibility state.

Before activation and immediately before model spawn, Gantry performs a
best-effort readiness check against durable target-agent capability bindings,
tool-capability broker health, selected MCP server materialization metadata,
MCP Gantry Secret references, and browser profile state. If setup is not ready,
the job is stored as `paused` with the short redacted `pause_reason`
`Setup required`, `next_run=null`, and structured `setup` metadata. User-facing
notifications render this as `Setup needed` with a short reason and one action.
The conservative setup states are:

```text
ready
missing_capability
broker_unreachable
credential_unknown
browser_login_may_be_required
mcp_missing_credential
draft_only
```

`Allow once` can resume the current blocked tool call in live interactive
permission prompts. `Allow 5 min` is also live-only; setup and scheduler
readiness prompts do not show it because timed grants are not durable readiness
for future recurring runs. Recurring activation requires a persistent
target-agent capability binding such as `Browser`, `capability:<id>`, an exact
Gantry file/web facade, an approved Gantry admin tool, a scoped
`RunCommand(...)` rule, or an approved MCP server binding. Browser auth remains
profile/session based; Gantry reports that login may be required unless the
profile already has durable state or auth markers.
MCP readiness may inspect materialized definitions and Gantry Secret refs, but
must not start arbitrary MCP servers as a readiness side effect.

## Execution

Scheduled job execution keeps protected capability and memory guards active
before autonomous allowance. If a tool is outside the effective job allowlist,
the runner uses the same permission IPC path as interactive agent runs: it sends
the approval prompt to the job's source conversation/thread or topic and waits
at the tool boundary. `Allow once` resumes that tool call in the current job
run. `Always allow` stores a semantic
`capability:<id>` grant when the request names one; otherwise it may apply
canonical `Browser`, an exact Gantry file/web facade, an exact Gantry admin
tool, or a scoped `RunCommand(...)` rule to the target agent. Broad exact
SDK/native tools and exact third-party MCP tool names remain one-off only. The
grant is mirrored to
`settings.yaml`, expanded into live runtime rules for the active run, and
resumes the same tool call so recurring jobs do not need the same approval next
time.

If the approval surface is unavailable, denied, or times out, the runner fails
the tool call with recovery guidance such as:

```text
Tool not on autonomous run allowlist: RunCommand.
Recovery: propose_capability { "capabilityId": "google.sheets.write", "reason": "This scheduled job writes the weekly status sheet." }
Recovery: request_permission { "permissionKind": "tool", "toolName": "RunCommand", "rule": "npm test *", "temporaryOnly": false, "reason": "This autonomous run needs scoped command access." }
```

Missing capability recovery uses the same reviewed request tools as interactive
agents: `capability_search` / `propose_capability` for semantic app/tool
access and new reviewed capabilities including authenticated CLIs,
`request_permission` for one-off Gantry file/web facades, Browser, or scoped
`RunCommand(...)` fallback, `request_skill_install` or `request_skill_proposal`
for skills, and
`request_mcp_server` for third-party MCP servers. Approval updates the target
agent's durable `capabilities` list or attached `sources`, exports the readable
projection to `settings.yaml`, and activates on the next scheduled run or a
manual rerun.

Job creation can declare `capability_requirements` on `scheduler_upsert_job`
instead of embedding provider-specific shell commands in the prompt. Each
requirement names a semantic capability id, a human reason, and optional
implementation hints such as `configured_access`, `local_cli`, `mcp_server`, or
`builtin_tool`. Gantry stores those requirements on the canonical job target and
derives `capability:<id>` tool-access-requirement rules from them. The pre-confirmation
plan shows the required capabilities in human terms, for example
`Google Sheets write using gog`.

If a job creation request needs a capability that does not exist yet, the
agent should propose a reviewed `local_cli` capability draft when the work is
backed by a pinned local CLI; otherwise the job remains paused until an
approved capability exists in the catalog. If the job later reaches a missing
tool or capability during a run, the run pauses through the same
permission/capability flow: the agent asks the user/admin, approval updates the
target agent, and readiness is evaluated again. The job is updated only when
its declared requirements were incomplete or
wrong; it never receives a job-local durable grant.

`local_cli` requirements are setup blockers until the agent proposes and the
user/admin approves a reviewed local CLI capability. They must declare an
absolute `executablePath`, pinned `executableVersion`, pinned `executableHash`,
and a narrow `commandTemplate`; any `authPreflight` must start with that exact
path, so readiness never depends on PATH resolution. They do not create or
imply broad `RunCommand(cli *)` authority. Runtime projects scoped command
authority only after capability review verifies executable identity, command
templates, protected paths, preflight behavior, and denied environment
overrides. Malformed persisted `local_cli` requirements are not converted into
capability proposals; the job must be updated with complete pinned CLI setup.
Configured built-in capabilities use `propose_capability` with only the
capability id and reason.

The scheduler records the failure summary, emits `job.tool_denied`, pauses
recurring jobs that need a missing persistent capability as `Setup required`,
and notifies the linked group/thread or DM with `Setup needed` unless the job is
silent.
Pre-spawn readiness blockers emit `job.setup_required` and pause before a
`JobRun` is claimed. After a run is claimed, the scheduler emits
`job.tool_activity` for tool-access-requirement preflight, SDK tool requests, allow/deny
decisions, permission waits, browser IPC actions, and tool-access readiness
results. Notification routes receive one terminal outcome message; they
do not receive streamed assistant output or full-output fallback messages.
Successful scheduled runs must end with a concise user-facing
`Final Job Report` that states the outcome, notable counts, and the next
action, and the terminal outcome message may summarize that report.
Browser calls made by jobs emit
`job.tool_activity` events with the job id, run id, tool name, result, elapsed
time, and normalized site.
When `Browser` is listed in `toolAccessRequirements`, readiness verifies that
the job has Browser access before launch. Browser use is observable through
tool-activity events, but successful runs do not fail merely because the agent
did not use an available Browser grant.
Terminal job events and run summaries include last heartbeat, last/current
tool, pending permission state, total tool calls, browser activity count, and
streamed-output size diagnostics.

Jobs use a job-owned `AgentSession` keyed by the target agent, source
conversation/thread, and `jobId`. That gives each job its own run history,
session digests, and durable Gantry evidence without provider resume handles.
Durable memory sharing is explicit: DM-created jobs extract and hydrate against
the trusted DM user subject, while channel/group/topic jobs extract and hydrate
against the trusted
conversation/thread subject. Caller-supplied memory subject overrides are not
part of job creation or update; the host derives the share target from
`executionContext`.

Host-owned job scripts are not supported. Raw host Bash is not equivalent to
Claude SDK Bash because it does not inherit the SDK filesystem sandbox,
provider tool lifecycle, or per-tool permission callback. Move job logic into
the scheduled prompt and grant semantic capabilities first, with scoped SDK
Bash only as a fallback low-level durable grant, through the normal capability
request flow. Any future script-like job runner must first
provide the same protected-path deny-write boundary on macOS, Linux, and Docker
deployments.

## Visibility

Jobs are inspectable through chat scheduler tools, Control API, SDK, and CLI.
List/detail output should include the target, schedule, status, model, prompt,
`executionContext`, `notificationRoutes`, and one canonical `toolAccess`
object:

```json
{
  "toolAccess": {
    "inheritedAgentTools": ["Browser", "FileRead", "RunCommand(npm test *)"],
    "effectiveAllowedTools": ["Browser", "FileRead", "RunCommand(npm test *)"],
    "projectedRuntimeTools": ["browser_open"],
    "source": "inherited target agent capabilities"
  },
  "health": {
    "state": "ready",
    "latestRunStatus": null,
    "activeRunId": null,
    "nextAction": null
  },
  "setup": {
    "state": "ready",
    "checkedAt": null,
    "fingerprint": null,
    "blockers": [],
    "nextAction": null
  }
}
```

`health.state` is the user-facing run condition for list/detail views. It can
show `ready`, the setup blocker states listed above, `running`, `completed`,
`failed`, `needs_permission`, `timed_out`, `dead_lettered`, `stale_lease`, or
`missed_window`.
The pg-boss scheduler runs periodic full sync maintenance so expired running
leases move to timed-out runs even when the process is otherwise idle.

Normal agent-facing scheduler MCP tools are not an admin surface. They may list,
read, mutate, inspect runs/events, inspect dead letters, and manually queue runs
only for jobs whose `group_scope` equals the calling agent group and whose
`execution_context.conversationJid` matches the originating conversation.
Threads/topics remain delivery metadata for notifications and spoof checks: a
thread id may be checked to prevent a caller from retargeting delivery outside
the authenticated thread, but it never grants job visibility or run authority.

Admin-wide job visibility and triggering remain on the Control API, SDK, and
local/admin CLI surfaces. Event inspection is exposed through the scheduler
MCP event tools, Control API `GET /v1/jobs/:jobId/events`, SDK `jobs.events`,
and `gantry jobs events <job_id> [--run <run_id>]`.
