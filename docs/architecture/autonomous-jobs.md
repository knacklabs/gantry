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
SDK/native request_permission grants, exact third-party MCP tool grants, bare
`Bash`, `Bash(*)`, leading-wildcard Bash scopes, scoped non-Bash rules, raw
Browser action MCP rules, and projected `mcp__myclaw__browser_*` rules are
invalid as persistent request_permission authority.

Browser is one durable public capability: `Browser`. A job with an inherited
`Browser` grant receives the projected MyClaw browser tools for that run. A job
without that inherited grant must request `Browser` through `request_permission`;
it must not request or persist raw Playwright, Puppeteer, agent-browser, or
projected browser action tool names.

## Execution

Scheduled job execution keeps protected capability and memory guards active
before autonomous allowance. If a tool is outside the effective job allowlist,
the runner uses the same permission IPC path as interactive agent runs: it sends
the approval prompt to the job's source conversation/thread or topic and waits
at the tool boundary. `Allow once` resumes that tool call in the current job run.
`Always allow` stores a semantic `capability:<id>` grant when the request names
one; otherwise it may apply canonical `Browser`, an exact MyClaw admin tool, or
a scoped Bash rule to the target agent. Broad exact SDK/native tools and exact
third-party MCP tool names remain one-off only. The grant is mirrored to
`settings.yaml`, expanded into live runtime rules for the active run, and
resumes the same tool call so recurring jobs do not need the same approval next
time.

If the approval surface is unavailable, denied, or times out, the runner fails
the tool call with recovery guidance such as:

```text
Tool not on autonomous job allowlist: Bash.
Recovery: request_capability { "capabilityId": "google.sheets.write", "reason": "This scheduled job writes the weekly status sheet." }
Recovery: request_permission { "permissionKind": "tool", "toolName": "Bash", "rule": "npm test *", "temporaryOnly": false, "reason": "This scheduled job needs scoped Bash access." }
```

Missing capability recovery uses the same reviewed request tools as interactive
agents: `capability_search` / `request_capability` for semantic app/tool
access, `propose_local_cli_capability` for reviewed authenticated CLIs,
`request_permission` for one-off exact tools, Browser, or scoped Bash fallback,
`request_skill_install` or `request_skill_proposal` for skills, and
`request_mcp_server` for third-party MCP servers. Approval updates the target
agent's durable bindings, exports the readable projection to `settings.yaml`,
and activates on the next scheduled run or a manual rerun.

The scheduler records the failure summary, emits `job.tool_denied`, pauses
recurring jobs that need a missing persistent capability, and notifies the
linked group/thread or DM unless the job is silent. Notification routes receive
one terminal outcome message; they do not receive streamed assistant output or
full-output fallback messages. Successful scheduled runs must end with a concise
user-facing `Final Job Report` that states the outcome, notable counts, and the
next action, and the terminal outcome message may summarize that report.
Browser calls made by jobs emit
`job.tool_activity` events with the job id, run id, tool name, result, elapsed
time, and normalized site.

Jobs use a job-owned `AgentSession` keyed by the target agent, source
conversation/thread, and `jobId`. That gives each job its own provider resume
handle, run history, and session digests. Durable memory sharing is explicit:
DM-created jobs extract and hydrate against the trusted DM user subject, while
channel/group/topic jobs extract and hydrate against the trusted
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
    "projectedRuntimeTools": ["mcp__myclaw__browser_navigate"],
    "source": "inherited target agent capabilities"
  },
  "health": {
    "state": "ready",
    "latestRunStatus": null,
    "activeRunId": null,
    "nextAction": null
  }
}
```

`health.state` is the user-facing run condition for list/detail views. It can
show `ready`, `running`, `completed`, `failed`, `needs_permission`,
`timed_out`, `dead_lettered`, `stale_lease`, or `missed_window`.
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
local/admin CLI surfaces.
