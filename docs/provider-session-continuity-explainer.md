# Provider-session continuity: the short version

This document explains the approved change; implementation and verification
are still pending. Gantry should not treat every model runner's session handle
the same way.

## Claude

A Claude SDK session lives only as long as its runner process. While that
runner is alive, Gantry's existing IPC loop sends follow-up messages into the
same query, so Claude keeps the useful conversational and tool context.

When the runner exits or the service restarts, Gantry starts a fresh Claude
session. It rebuilds the prompt from bounded recent channel/thread messages,
durable memory, and the new pending message. It does **not** resume Claude's old
opaque transcript and does not ask Claude to create a handoff capsule.

The new runner sees the bounded selection of messages and memory that Gantry
loads, not every stored record. Older durable records can still exist without
being included in that prompt. It cannot see a
private tool detail that existed only inside Claude's old process. Important
outcomes therefore belong in normal durable messages, memory, events, or
artifacts—not in an ever-growing provider transcript.

## DeepAgents

DeepAgents is different because Gantry owns its LangGraph checkpoint state in
Postgres. It keeps cross-process resume, the existing context high-water mark,
and the configured threshold. Adapter-owned checkpoint cleanup is separate
pending work, not part of this fix.

## What happens to the threshold?

The setting remains:

```yaml
limits:
  provider_session_max_input_tokens: 150000
```

It protects adapters that support cross-process sessions, including
DeepAgents. Claude's live process continues to rely on its existing idle
lifecycle and SDK compaction. There is no extra summarisation call and no
mid-query rollover protocol in this change.

## Rollout

On a cold run after deployment, an old active or ready Claude handle is
retired through Gantry's fenced retirement path. A compaction already running
keeps ownership and may finish or time out; a new cold runner ignores its
locked handle. Any resulting ready handle is retired on a later encounter.
No stored handle is passed back to the new Claude runner, and no replacement
cross-process handle is stored.

Forge delivery is split into two tasks: shared support first, then behavior
activation after the first PR merges. The first task alone does not fix token
growth. Both require tests and review; merging remains human-approved.

The result is deliberately simple: same-process Claude continuity, bounded
cold starts from Gantry's durable truth, and provider-specific handling for
DeepAgents.
