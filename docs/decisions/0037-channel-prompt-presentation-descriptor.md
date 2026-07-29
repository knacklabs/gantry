---
status: proposed
confirmed_by: ""
date: 2026-07-22
---

# Channel Prompt Presentation Descriptor

## Context

`prompt-profile-service.ts:332-357` hard-codes `telegram`/`slack` labels,
formatting guidance, and message caps in the application layer — flagged by
the Provider-Specific Paths gate. The channel provider registry
(`apps/core/src/channels/provider-registry.ts`) already owns `label`, `jidPrefix`, and
`formatting`, but not prompt wording; the architecture map forbids the
application layer importing the registry.

## Decision

`Provider` gains an optional prompt-presentation descriptor (label,
formatting description, max-message guidance, attachment guidance). The
channel side renders the exact existing sentence and passes the COMPLETED
string into `PromptRuntimeContext`; the application service only appends it.

## Consequences

- Byte-identical prompt output is the migration invariant, pinned by a
  before/after equality test for telegram/slack/default.
- Application code never imports the provider registry; new channels add a
  descriptor instead of another application-layer branch.
