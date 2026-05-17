# Autonomous Jobs

Autonomous jobs are runtime state, not desired-state configuration. Recurring,
one-time, and manually triggered scheduler jobs are stored in Postgres and must
not be written to `settings.yaml`.

## Capability Resolution

At execution time, a job resolves its target agent from the runtime target:
`group_scope` plus `execution_context` (`conversationJid`, optional `threadId`,
optional `sessionId`). The job inherits that target agent's currently selected
tool bindings, skills, and MCP server bindings for the run. Job records do not
carry separate tool, skill, or MCP capability grants.

Inherited tool grants are semantic capability entries such as
`capability:google.sheets.write`, canonical `Browser`, selected first-party
catalog tools, exact MyClaw admin tools, approved third-party MCP server
bindings, or scoped Bash rules such as `Bash(npm test *)`. Runtime expands
semantic capabilities and may still project approved third-party MCP server
bindings into SDK allowances for that run. Empty rules, global `*`, broad exact
SDK/native request*permission grants, exact third-party MCP tool grants, bare
`Bash`, `Bash(*)`, leading-wildcard Bash scopes, scoped non-Bash rules, private
browser backend rules, and projected browser gateway rules are
invalid as persistent request_permission authority.

Browser is one durable public capability: `Browser`. A job with an inherited
`Browser` grant receives the projected MyClaw browser gateway for that run. A job
without that inherited grant must request `Browser` through `request_permission`;
it must not request or persist private browser backend names or projected
browser gateway tool names.

## Readiness Gates

Job create/update surfaces accept declared setup requirements:

- `requiredTools`: durable readable tool rules such as `Browser`,
  `capability:google.sheets.write`, exact first-party MyClaw MCP tools, or
  scoped `Bash(...)` rules.
- `requiredMcpServers`: approved third-party MCP server names or ids expected
  by the job.

The declarations are UX assertions, not authorization. The runtime still
enforces actual tool use at the permission boundary, and under-declared jobs
pause if a run later reaches a denied tool.
Create/update surfaces validate these assertions up front. Unsupported raw
browser backend names, projected browser gateway names, MyClaw wildcards, broad
or bare Bash, and scoped non-Bash rules fail the request instead of becoming
compatibility state.

Before activation and immediately before model spawn, MyClaw performs a
best-effort readiness check against durable target-agent capability bindings,
tool-capability broker health, selected MCP server materialization metadata,
MCP credential references, and browser profile state. If setup is not ready,
the job is stored as `paused` with the short redacted `pause_reason`
`Setup required`, `next_run=null`, and structured `setup` metadata. The
conservative setup states are:

```text
ready
missing_capability
broker_unreachable
credential_unknown
browser_login_may_be_required
mcp_missing_credential
draft_only
```

`Allow once` can resume the current blocked tool call, and `Allow 5 min` can
reduce repeated prompts for the same short run, but neither is durable readiness
for future recurring runs. Recurring activation requires a persistent
target-agent capability binding such as `Browser`, `capability:<id>`, an exact
approved MyClaw admin tool, a scoped Bash rule, or an approved MCP server
binding. Browser auth remains profile/session based; MyClaw reports that login
may be required unless the profile already has durable state or auth markers.
MCP readiness may inspect materialized definitions and broker credential refs,
but must not start arbitrary MCP servers as a readiness side effect.

## Execution

Scheduled job execution keeps protected capability and memory guards active
before autonomous allowance. If a tool is outside the effective job allowlist,
the runner uses the same permission IPC path as interactive agent runs: it sends
the approval prompt to the job's source conversation/thread or topic and waits
at the tool boundary. `Allow once` resumes that tool call in the current job
run, while `Allow 5 min` is temporary. `Always allow` stores a semantic
`capability:<id>` grant when the request names one; otherwise it may apply
canonical `Browser`, an exact MyClaw admin tool, or a scoped Bash rule to the
target agent. Broad exact SDK/native tools and exact third-party MCP tool names
remain one-off only. The grant is mirrored to
`settings.yaml`, expanded into live runtime rules for the active run, and
resumes the same tool call so recurring jobs do not need the same approval next
time.

If the approval surface is unavailable, denied, or times out, the runner fails
the tool call with recovery guidance such as:

```text
Tool not on autonomous run allowlist: Bash.
Recovery: request_capability { "capabilityId": "google.sheets.write", "reason": "This scheduled job writes the weekly status sheet." }
Recovery: request_permission { "permissionKind": "tool", "toolName": "Bash", "rule": "npm test *", "temporaryOnly": false, "reason": "This autonomous run needs scoped Bash access." }
```

Missing capability recovery uses the same reviewed request tools as interactive
agents: `capability_search` / `request_capability` for semantic app/tool
access, `propose_local_cli_capability` for reviewed authenticated CLIs,
`request_permission` for one-off exact tools, Browser, or scoped Bash fallback,
`request_skill_install` or `request_skill_proposal` for skills, and
`request_mcp_server` for third-party MCP servers. Approval updates the target
agent's durable bindings, exports the readable projection to `settings.yaml`,
and activates on the next scheduled run or a manual rerun.

Job creation can declare `capability_requirements` on `scheduler_upsert_job`
instead of embedding provider-specific shell commands in the prompt. Each
requirement names a semantic capability id, a human reason, and optional
implementation hints such as `configured_access`, `local_cli`, `mcp_server`, or
`builtin_tool`. Gantry stores those requirements on the canonical job target and
derives `capability:<id>` required-tool rules from them. The pre-confirmation
plan shows the required capabilities in human terms, for example
`Google Sheets write using gog`.

`local_cli` requirements are setup blockers until the generated absolute scoped
Bash rule is approved for that job or agent. They must declare an absolute
`executablePath`; `commandTemplate` and any `authPreflight` must start with that
exact path, so readiness never depends on PATH resolution. They do not create or
imply broad `Bash(cli *)` authority. Reusable user-defined `local_cli` semantic
capabilities stay draft-only until runtime enforcement verifies executable
identity, command templates, protected paths, preflight behavior, and denied
environment overrides. Malformed persisted `local_cli` requirements are not
converted into legacy capability proposals; the job must be updated with the
absolute executable template. Configured built-in capabilities use
`request_capability`.

The scheduler records the failure summary, emits `job.tool_denied`, pauses
recurring jobs that need a missing persistent capability as `Setup required`,
and notifies the linked group/thread or DM unless the job is silent.
Pre-spawn readiness blockers emit `job.setup_required` and pause before a
`JobRun` is claimed. After a run is claimed, the scheduler emits
`job.tool_activity` for required-tool preflight, SDK tool requests, allow/deny
decisions, permission waits, browser IPC actions, and required-tool
satisfaction. Notification routes receive one terminal outcome message; they
do not receive streamed assistant output or full-output fallback messages.
Successful scheduled runs must end with a concise user-facing
`Final Job Report` that states the outcome, notable counts, and the next
action, and the terminal outcome message may summarize that report.
Browser calls made by jobs emit
`job.tool_activity` events with the job id, run id, tool name, result, elapsed
time, and normalized site.
When `Browser` is listed in `requiredTools`, a completed model run is only
successful if at least one browser IPC action was observed for that run. If
Browser was available but unused, the run fails with an explicit Browser
unsatisfied diagnostic rather than a generic timeout or silent completion.
Terminal job events and run summaries include last heartbeat, last/current
tool, pending permission state, total tool calls, browser activity count, and
streamed-output size diagnostics.

Jobs use a job-owned `AgentSession` keyed by the target agent, source
conversation/thread, and `jobId`. That gives each job its own run history,
session digests, and durable MyClaw evidence without provider resume handles.
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
    "inheritedAgentTools": ["Read", "Bash(npm test *)"],
    "effectiveAllowedTools": ["Read", "Bash(npm test *)"],
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
and `myclaw jobs events <job_id> [--run <run_id>]`.
