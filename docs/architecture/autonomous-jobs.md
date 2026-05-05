# Autonomous Jobs

Autonomous jobs are runtime state, not desired-state configuration. Recurring,
one-time, and manually triggered scheduler jobs are stored in Postgres and must
not be written to `settings.yaml`.

## Capability Policy

At execution time, a job resolves its target agent from the job runtime target:
`group_scope`, linked conversation/session, and optional thread/DM context. The
job inherits that target agent's currently selected tool bindings for the run.

Job-scoped extra tool rules are persisted in `jobs.target_json` under:

```json
{
  "capabilityPolicy": {
    "allowedTools": ["mcp__agent_browser__*"]
  }
}
```

Missing `capabilityPolicy.allowedTools` means an empty extra-tool list.

Allowed job tool rules support exact tool names and `mcp__server__*`. Empty
rules, global `*`, and other wildcard forms are invalid. Non-main jobs cannot
add main/admin-only MyClaw tools as job extras.

## Execution

Scheduled job execution keeps protected capability and memory guards active
before autonomous allowance. It must not write permission IPC or wait for chat
approval during execution. If a tool is outside the effective job allowlist, the
runner denies it immediately with:

```text
tool not on autonomous job allowlist
```

The scheduler records the failure summary, emits `job.tool_denied`, and notifies
the linked group/thread or DM unless the job is silent.

## Visibility

Jobs are inspectable through chat scheduler tools, Control API, SDK, and CLI.
List/detail output should include the target, schedule, status, model, prompt,
notification target, job extra tools, and effective autonomous tool surface.

Normal agent-facing scheduler MCP tools are not an admin surface. They may list,
read, mutate, inspect runs/events, inspect dead letters, and manually queue runs
only for jobs whose `group_scope` equals the calling agent group and whose
`linked_sessions` includes the originating conversation. Threads/topics remain
delivery metadata for notifications and spoof checks: a thread id may be
checked to prevent a caller from retargeting delivery outside the authenticated
thread, but it never grants job visibility or run authority.

Admin-wide job visibility and triggering remain on the Control API, SDK, and
local/admin CLI surfaces.
