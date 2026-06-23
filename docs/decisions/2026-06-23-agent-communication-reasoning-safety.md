# Agent Communication Reasoning Safety

## Context

Agent communication UX can benefit from concise progress and evidence, but raw
provider reasoning, hidden chain-of-thought, and runner diagnostics are not safe
or useful as user-facing output.

## Decision

Expose only authored progress, explicit todo state, terminal receipts, and safe
provider summaries. Do not stream or store raw reasoning as user-visible channel
content unless a provider offers a documented summarized-reasoning stream that is
safe for display.

## Alternatives considered

- Display every provider reasoning delta. Rejected because it can leak hidden
  reasoning and provider-private implementation details.
- Add a Gantry-generated reasoning transcript. Rejected because it would imply
  evidence that the runtime did not actually observe.

## Consequences

Progress cards and receipts must be written in channel-neutral operational
language. Any future summarized-reasoning feature needs a separate provider
adapter contract and tests proving unsafe content is not exposed.

## Rollback or migration notes

Existing progress and receipt copy remains valid. New reasoning display can be
removed without data migration if kept out of durable authority state.
