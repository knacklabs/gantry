---
status: accepted
confirmed_by: "vrknetha"
date: 2026-07-27
---

# LAT-GATE-0 Client Signoff

## Context
The response-latency program cannot be shipped cleanly until the current-main
validation gates are trustworthy. Three fixture defects currently block that
prerequisite: a five-second DeepAgents permission-request wait, an MCP hot-path
fixture missing reviewed capability evidence, and a hermetic job-lifecycle fake
Claude executable that waits for a stale startup trigger.

The client asked for all response-latency phases to proceed autonomously, with
each PR reviewed, locally verified, CI-green, and the KnackLabs lead-gen job
passing before merge. This bounded prerequisite is required before the first
latency PR can honestly meet those gates.

## Decision
Approve LAT-GATE-0 to repair exactly those three current-main validation
fixtures before continuing the response-latency PR train.

## Consequences
The repair is test-only. It must not change production authorization, runtime
behavior, lint policy, or the LAT-0 latency harness branch. Existing signed IPC,
reviewed MCP capability, sandbox, and scheduler boundaries remain authoritative.
