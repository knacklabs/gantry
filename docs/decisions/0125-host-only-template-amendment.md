---
status: proposed
confirmed_by: ""
date: 2026-08-12
stories: [JOBFLOW-1]
---

# Host-Only Template Amendment [JOBFLOW-1]

Amends 0122 (agent-proposed amendments; argv in dedup identity) and 0123
(amendment-surfacing via birthright tools). Closes deferral D-0057.

## Context

Agent-authored proposals require the agent to synthesize executable
authority text, and argv-based dedup identity lets equivalent proposals
multiply. The host already holds verified context (app, run, job,
capability, argv) at the exact moment a template mismatch occurs.

## Decision

Capability template amendment proposals are HOST-COMPILED only: the host
capability-run handler invokes the compiler/proposal service directly
in-path on a recognized mismatch (the typed event is observability, not
transport). The agent-authored amendment path (MCP tool target, schema,
switch branch) is REMOVED; 0123's other birthright recovery tools stay.
Proposal identity = (appId, capabilityId, canonical proposedTemplates);
observed argv leaves the identity and is stored as ONE first redacted
evidence sample. A flagged observation proposes BOTH full pinned-path
templates (base positional + flagged variant, flag values wildcarded).
Compiler eligibility: exactly one literal-prefix catalog match, trailing
extension only, mixed-glob templates ineligible — everything else falls
to a plain-language instruction. Approval inserts a durable
approval-intent row INSIDE the amendment transaction (app-wide scope;
completion = every target resumed or superseded; retries on the shared
recovery tick) — approve→amend→resume is durable, not best-effort.

## Consequences

- One proposal entry point; a runner can never claim host evidence.
- canonical_key data migration (keep-newest, supersede-older via the
  existing denied/system:superseded encoding).
- Argv redaction extended (--account <email>, NAME@host) before any
  persistence.
- Rejected (do not re-propose): keeping both proposal entry paths; SQL
  unblock of paused jobs; argv in dedup identity; a new supersession
  status; folding intent recovery into the delivery repository.
Full contracts: plans/JOBFLOW-contract-appendix.md (S4).
