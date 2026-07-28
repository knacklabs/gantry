# LAT-3A Single-Memory-Hydration Measurement

## Measured change

The deterministic ordinary inbound-turn scenario counts hydration at the
repository seam the runner actually calls:
`GroupProcessingRepository.getAgentTurnContext`. A call counts as a hydration
when `hydrateMemory !== false`, matching the production service gate.

| Measurement                       | Before | After | Saved per ordinary inbound turn |
| --------------------------------- | -----: | ----: | ------------------------------: |
| `memory_hydrate_calls`            |      2 |     1 |                     1 hydration |
| Total `getAgentTurnContext` reads |      2 |     2 |                         0 reads |

The before value is the LAT-3A-1 parent behavior: the provisional read and the
later promoted read both hydrated. The after value uses the same deterministic
scenario: the provisional read hydrates, while the later read passes
`hydrateMemory: false` and carries the provisional memory block only when the
agent-session identity fence matches.

## Repository work avoided

One `HydrateAgentContextService.hydrate` execution performs these logical
repository reads:

- `agent_sessions`: load the durable agent session.
- `agent_session_digests`: load recent digests for that session and scope.
- `memory_items`: recall active durable memory for the resolved subject.
- `conversations`: resolve conversation kind and the external conversation
  reference used by scoped recall and continuity jobs.
- `canonical_jobs`: load active or paused continuity jobs for the session
  conversation and thread.
- `control_http_sessions`: join canonical jobs back to their app/session and
  conversation ownership.

The digest, memory, and continuity-job branches run concurrently after the
agent-session read. LAT-3A therefore saves one execution of this complete
hydration fan-out on each ordinary inbound turn. It does not remove the later
canonical session-context read itself.

## Why there is no p50/p95 here

The program requires p50 and p95 "where timing is meaningful". It is not
meaningful for this change, and reporting it would be theater rather than
evidence.

The deterministic scenarios run against a fake repository with manual time, so
wall-clock per hydration is whatever the harness injects. A p50/p95 derived from
an injected delay would only restate the delay constant chosen by whoever wrote
the fixture — it would look like a measurement of production while being a
measurement of the fixture. The real saving is one hydration fan-out per turn,
whose production cost depends on live table sizes, index state, and connection
contention that no hermetic fixture reproduces.

The operation-count delta above is therefore the honest evidence for this phase.
Turning it into a millisecond figure requires measuring the deployed runtime,
which is out of scope here.

## What did not improve

- Total `getAgentTurnContext` reads on the normal turn remain 2. Only the
  hydration flag on the later read changed.
- A fence mismatch adds a third `getAgentTurnContext` read so the new session
  can be hydrated safely. That exceptional path performs two hydrations: the
  provisional one and the replacement hydration.
- Admission is unchanged, including its existing non-hydrating context read.
- Provider request latency and model time to first token were not measured or
  changed by this stage.
- No end-to-end first-content latency improvement was measured, so this result
  does not claim one.
- Scheduled-job execution is unchanged; LAT-3A only covers inbound interactive
  turns.
- Provider adapters, model invocation, memory scoring and recall limits,
  durable writes, and the model-visible context rendering are unchanged.
