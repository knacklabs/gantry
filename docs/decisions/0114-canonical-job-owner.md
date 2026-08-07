---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-07
stories: [LEGACY-1]
---

# Canonical Job Owner: No JID/Default-App Authorization [LEGACY-1]

## Context

The job reader reconstructs ownership for jobs lacking canonical fields: a
missing/malformed target is synthesized into an execution context; workspace
falls back to the agent id or the literal `"system"`; a missing session is
resolved through `conversationJid`; and for the default app the access layer
mints a synthetic session with `sessionId: ''`. Verification showed this is
app-gated (not a cross-tenant escalation today), but it preserves several
ownership models for the same job, which makes job state hard to reason about
and audit — and it violates `0003`. A `conversationJid` is a routing id, not a
durable ownership id.

## Decision

Job ownership is an explicit discriminated type:

```
type JobOwner =
  | { kind: 'user_session'; appId: string; sessionId: string; agentId: string }
  | { kind: 'host_system'; systemJobType: string }
```

- Every user-created job requires a canonical `user_session` owner.
- System jobs are explicitly `host_system`.
- Authorization is **never** inferred from `conversationJid`, default-app status,
  obsolete top-level fields, or a synthetic empty session; malformed target data
  **fails closed** rather than synthesizing a `"system"` workspace.
- Existing rows are **migrated** (restamped) to a canonical owner once, using the
  ID-1 identity map (`0101`); then the reconstruction branches and the tests that
  assert "legacy sessionless job" behavior are deleted.

## Consequences

- After migration, a sessionless user job cannot be triggered/read/updated/
  paused/resumed; a `host_system` job stays operable without a user session.
- The same JID in two apps or accounts cannot confer access.
- Relates `0019`/`0101`/`0106`/`0107`/`0108`. Coordinate the migration with the
  SCHED-4B lane, which touches the same files on `main`.
