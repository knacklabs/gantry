---
status: proposed
confirmed_by: ""
date: 2026-07-26
---

# Parallel Tool Execution

**Status is `proposed` on purpose.** Design only. Numbered 0061 because 0060 is held by ASYNC-1
on an unmerged branch — see [[decision-number-collision-parallel-branches]].

## Context

The question raised was whether agents can make parallel tool calls today, on the assumption
they cannot and that adding it would be a performance win.

**They already can.** The model emits several `tool_use` blocks in one message, and gantry has
`apps/core/src/channels/permission-batch-coalescer.ts` specifically to handle several tools
needing approval at once — collapsing them into a single prompt rather than interrupting the
human repeatedly. Batch coalescing would not exist if calls did not arrive in batches. The SDK
also exposes a `PostToolBatch` hook (unused by gantry).

**What is NOT established** is whether those calls genuinely execute concurrently end to end, or
serialise somewhere below the model — most plausibly in the MCP transport or while awaiting
permission decisions. `query-loop.ts` simply iterates SDK messages; the SDK owns tool
execution, so any gantry-side bottleneck would sit in the tool server or the permission gate.

This distinction decides whether there is a performance win available at all. Claiming one
before measuring would repeat an error made twice already in this cycle: asserting a
quantitative benefit (tool-schema token cost, async duration distribution) from intuition
rather than measurement.

## Decision (proposed)

**Measure before building.** Establish whether concurrent tool calls actually overlap, by
instrumenting start and end timestamps per tool call within a single turn. If they already
overlap, there is no work to do beyond policy. If they serialise, fix the bottleneck rather
than adding a new parallelism mechanism.

The policy below applies either way, because it governs what SHOULD be allowed to overlap.

### Policy (decided with the owner, 2026-07-26)

1. **Reads may overlap; writes are serialised.** Lookups run concurrently, which is where the
   speed-up lives. Anything that changes state waits its turn, so two operations cannot race
   the same record. This mirrors the read-only classification the permission rails already
   compute, so the signal exists rather than needing invention.
2. **One approval prompt per batch.** When several tools in a batch need approval, the human is
   asked once, covering all of them. This is roughly what the coalescer does today. Accepted
   cost: the human cannot approve some and refuse others within a batch.
3. **A small concurrency limit, extras queue.** Keeps a single turn from monopolising the host
   or producing a surprise bill. The limit is fixed rather than per-kind, for predictability.
4. **A failure does not cancel its siblings.** If one call in a batch fails, the others run to
   completion and the agent receives the successes plus the error, deciding what to do next.
   Work already paid for is not discarded.

## Consequences

- Serialising writes requires a reliable read/write classification per tool. The permission
  rails already compute a read-only signal, so this should reuse that rather than introduce a
  second, divergent notion of "safe" — two classifications that can disagree is a bug source.
- Single-prompt-per-batch means partial approval is not expressible. If that turns out to
  matter in practice, it is a UI change, not a contract change.
- A concurrency limit interacts with the async work in [[async-completion-contract]]: both
  bound how much a single agent can have in flight. They should share one budget rather than
  each imposing an independent cap that the other cannot see.
- If measurement shows calls already overlap, this decision reduces to policy only, and the
  performance premise behind the original question is simply wrong. That is a satisfactory
  outcome and should be recorded as such rather than quietly dropped.

## Open questions

1. **Do parallel tool calls actually overlap today?** Instrument per-call start/end within one
   turn. Everything else is secondary to this.
2. If they serialise, where — the MCP stdio transport, the permission gate awaiting a decision,
   or the SDK's own executor?
3. What is the right concurrency limit, and is it shared with the async in-flight budget?
4. Does the batch approval prompt scale visually? Five tools in one prompt may be unreadable
   on a phone, which is the primary surface here.
