---
status: proposed
confirmed_by: ""
date: 2026-07-30
---

# Sender Allowlist Becomes Trigger-Only — `drop` Mode Removed

## Context

The sender allowlist has two modes: `trigger` (store everything, gate who may
trigger a reply — the shipped default, `allow: '*'`) and `drop` (suppress
persistence entirely for non-allowed senders,
`apps/core/src/app/bootstrap/channel-persistence-handlers.ts:146`, plus the
hydrated-message suppression at
`apps/core/src/runtime/group-conversation-context.ts:214`). A dropped message
is a permanent hole no hydration, watermark, or larger window recovers — the
exact failure class behind the GH-352 report. `drop` has no documenting
decision, no docs, and the unmatched-provider fallback
`DEFAULT_ENTRY = { allow: [], mode: 'drop' }`
(`apps/core/src/platform/sender-allowlist.ts:77`) leans deny-AND-forget. The
client's model (2026-07-30): "the agent can read all; the trigger using @ or
direct is to reply when asked." Deferral D-0030 asked what drop should mean;
this decision answers it.

## Decision

`mode: 'drop'` is removed. The allowlist's ONLY job is trigger gating: every
inbound message on a registered route is persisted regardless of sender;
`isSenderAllowed` continues to decide who may trigger a reply. The fallback
entry becomes trigger-shaped. Legacy configs that say `mode: drop` on disk are
**normalized to trigger at the parser** — never a crash, never a silent
fallback to defaults (today an invalid mode throws in `parseSenderPolicy` and
`loadSenderAllowlist` catches it by discarding the WHOLE config,
`apps/core/src/config/settings/runtime-settings-parser.ts:127`,
`apps/core/src/platform/sender-allowlist.ts:220` — normalization must happen
before that cliff).

## Consequences

- Both persistence suppressions go: normal inbound and hydrated-message paths
  become store-always. The read-all guarantee gets a real Postgres integration
  test (none exists today asserting persistence for a non-allowed sender).
- Trigger gating is untouched: `isTriggerAllowed` never read `mode`
  (`apps/core/src/platform/sender-allowlist.ts:337`); group, replay,
  thread-continuation and session-command gates keep working unchanged.
- The mode union narrows across config validation, platform types, contracts,
  SDK, CLI (`--mode drop` parsing, and the setup flow's "Only listed senders"
  choice which currently writes `drop`,
  `apps/core/src/cli/setup-add-conversation.ts:291` — it now writes trigger
  gating with the listed senders). The settings renderer writes the
  normalized value back.
- Privacy stance made explicit: there is deliberately NO "never record this
  sender" switch after this change. If a genuine compliance need appears, it
  returns as its own explicit, documented, loudly-labelled decision — not as
  an allowlist side effect. Resolves D-0030.
- Docs asserting drop-mode persistence suppression (decision 0087's boundary
  note, `docs/architecture/runtime-components.md`) get updated to describe the
  new invariant.
