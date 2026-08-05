---
status: proposed
confirmed_by: ""
date: 2026-08-05
stories: [SCHED-5]
---

# Semantic Capability IDs Are the Canonical Job Dependency

## Context

A job requirement can be a semantic capability, a raw tool rule, an MCP
server, or a capability with embedded implementation metadata — each
deduplicated independently, so capability:google.sheets.values.append and a
raw RunCommand Sheets rule coexist as competing representations of one
dependency. Jobs end up owning implementation details (executables, command
grammar, provider server names) that belong to the capability catalog, and a
run's incidental shell choice can become a permanent readiness dependency.
This is how the lead job got a raw Sheets command requirement alongside the
ready semantic capability.

## Decision

Semantic capability IDs are the canonical job dependency: a job declares
{capabilityId, reason} and the reviewed capability catalog resolves the
implementation at preflight and run time. Raw command requirements remain
only as an explicit escape hatch for genuinely technical jobs, and are
REJECTED when the catalog proves a reviewed semantic capability already
covers the command. A migration replaces existing raw workarounds with their
matching capability IDs and pauses only jobs with no reviewed mapping.

## Consequences

- Jobs stop storing executable paths, hashes, and command templates;
  implementation ownership consolidates in the capability catalog.
- Scheduled runs see ready ACTIONS (capability catalog guidance) instead of
  raw command rules — the same catalog interactive runs already get.
- The escape hatch stays honest: raw command requirements are possible but
  duplicate-of-capability writes are refused.
- Ships LAST in the program (SCHED-5), after the correctness blockers,
  job repair, revision fencing, and observability land.
