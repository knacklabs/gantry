# Callable agents (agents as tools)

Let one agent (the *orchestrator*) delegate work to other agents it has been
explicitly allowed to call. Each allowed delegate appears to the orchestrator
as a tool; calling it runs the delegate agent and returns its result.

## Configure

Declare, per orchestrator, which agents it may call — `agents.<folder>.delegates`
in `settings.yaml` (immutable agent folders/ids):

```yaml
agents:
  main_agent:
    name: Main
    delegates:
      - researcher
      - data_analyst
```

Empty or absent means the orchestrator gets no delegation tools. Entries that
do not resolve to an active agent in the same app are skipped with an operator
warning in the runtime log. Only delegates bound to the current conversation
are offered — an agent that is active but not installed in the conversation is
not projected.

### API

- `GET /v1/agents/:id/delegates` — the configured list plus the *resolved*
  roster (which delegates actually project to a tool, with persona).
- `PUT /v1/agents/:id/delegates` — replace the list. Each entry is validated
  against registered agents (unknown, self, and duplicates are rejected) and
  persisted through the canonical desired-state settings path (a settings
  revision is created; the settings watcher applies it).

Requires the `agents:admin` control scope.

## What the orchestrator sees

One tool per delegate, named `delegate_to_<name>_<digest>`, described with the
delegate's display name and persona (e.g. `Delegate to Ada (research).`).
Input:

| field | | |
|---|---|---|
| `objective` | required | what the delegate should do |
| `context` | optional | background to pass along |
| `expectedOutput` | optional | the shape of answer wanted |
| `timeoutMs` | optional | delegate execution cap (max 30 min) |
| `syncWaitTimeoutMs` | optional | how long the caller waits inline (max 60 s) |

## Result flow (hybrid)

The orchestrator waits up to `syncWaitTimeoutMs`. If the delegate finishes in
time, the result returns inline (bounded to a few KB; longer results say so and
point at `task_get` with the task id for the full text). If not, the tool
returns a queued task id, the delegate keeps running durably, and when it
finishes the runtime **delivers a follow-up message into the orchestrator's
conversation** — the "I'll follow up" narration is kept automatically, across
restarts. Full results are always retrievable losslessly via `task_get`.

## Permission

Delegation is gated like any other privileged tool: every callable-agent tool
canonicalizes to the `AgentDelegation` authority. In ask mode the user gets an
approval prompt (Allow once / Allow for future / Cancel); in auto mode it
follows the agent's configured rules. Delegated children cannot delegate
further (depth-1, enforced at runtime), and the delegate target is pinned
host-side — the model cannot redirect a call to an agent outside the allowlist.

## What the human sees

The conversation narrates the delegation: who was called and a short objective
snippet, then the outcome — response received, still working (follow-up
promised and delivered), or the failure reason.

## Limits (v1)

- Depth-1 only: a delegate cannot itself delegate.
- Concurrency is bounded by the shared async-task backlog (32 per agent,
  64 per app).
- Delegated-child token usage is not yet itemized per delegation in the
  conversation.
