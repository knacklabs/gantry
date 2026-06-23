# Agent Communication Reaction Binding

## Context

Gantry needs lightweight review affordances on agent-originated messages without
turning channel reactions into durable permission authority. Slack, Discord, and
Telegram expose message reaction APIs that can represent feedback on a specific
delivered message. Teams reaction support requires Graph chat message authority
that the current Teams bot runtime does not own.

## Decision

Bind supported reaction events to the delivered channel message and convert them
only into review signals. Reactions must not create, widen, persist, or revoke
permissions. The runtime records the signal as observable feedback tied to the
message/run context when the channel can prove the event belongs to a Gantry
delivered message.

Teams reactions are deferred until the Teams runtime has a verified authority
path for the Graph `chatMessage.setReaction` surface or an equivalent bot-owned
reaction event path.

## Alternatives considered

- Treat reactions as approval decisions. Rejected because approvals require
  durable pending-interaction records and explicit decision options.
- Store channel-specific reaction state as a new source of truth. Rejected
  because reactions are review metadata, not runtime authority.

## Consequences

Slack, Discord, and Telegram adapters may add channel-specific reaction
translation behind a shared review-signal contract. Teams must degrade by
omitting reaction controls until authority is proven.

## Rollback or migration notes

Reaction review signals can be disabled per adapter without migrating runtime
authority because they are not permission state.
