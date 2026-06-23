# Teams Reactions Deferred

## Context

The Teams runtime currently sends bot messages and Adaptive Cards through the
bot channel path. Microsoft Graph supports setting reactions on chat messages,
but that is a different authority lane from the current bot delivery adapter.

## Decision

Do not implement Teams reaction controls in the current agent communication UX
slice. Teams should continue to show explicit buttons or Adaptive Card actions
for reviewed user decisions, and omit lightweight reaction affordances.

## Alternatives considered

- Call Graph reaction APIs from the bot adapter. Rejected because the runtime
  has not established Graph chat-message authority for live Teams delivery.
- Emulate reactions with Adaptive Card buttons. Rejected for this slice because
  buttons imply explicit actions and are already used for approvals.

## Consequences

Teams behavior stays conservative and authority-correct. Slack, Telegram, and
Discord reaction work must not depend on Teams parity.

## Rollback or migration notes

When Teams Graph authority is added and verified, this decision can be replaced
by a Teams-specific reaction binding decision.
