---
status: accepted
confirmed_by: "Ravi"
date: 2026-09-10
stories: []
---

# A granted capability must be discoverable before its call shape is relaxed

## Context

The KnackLabs lead-maintenance job holds a reviewed grant for
`google.sheets.values.get`, a semantic capability bound to a local CLI. In seven
consecutive runs the agent opened every run by burning failed calls before its
first successful sheet read, in a fixed order: an MCP server that does not
exist, a tool that does not exist, then arguments outside the reviewed template.
The job prompt never mentions that machinery, so the probing is the model's own.

Only the third failure is a template mismatch. The first two are the model
reaching for shapes it knows from training because it cannot see the shape it
actually has. That run reported 62 allowed tools but only 11 available to the
model, with tool search in automatic mode
(`apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-search-decision.ts:88`).

A first attempt rendered the reviewed argv patterns into the system prompt
(97ded3746). It deployed and changed nothing: the next run failed identically.
Prose cannot help a model choose a tool it cannot currently see.

The tempting next step was to remove the argv template as an enforcement gate and
let the permission classifier judge the real command instead, freeing the model
from templates that cannot anticipate flags, quoting and composition. Read against
the accepted record, that step is unsafe today and would not even fix the
reported failure.

- 0120 makes argv validation the boundary deliberately: a pinned executable alone
  is insufficient, because flags such as `--config`, `--output` and `--account`
  change behaviour without shell syntax. The credential and account scoping of a
  local CLI capability is in large part implemented by that validation, not
  merely accompanied by it.
- 0130 states that `capability_run` receives no classifier-derived or cached
  allow, and that the wrapper's bypass grants no command authority.
- In `direct` mode there is no operating-system confinement beneath the
  authorization layer, so removing argv validation leaves no second net.
- Removing the gate addresses only the third failed call. The first two are
  discovery failures and would continue unchanged.

## Decision

Discovery is the defect to fix. A capability the agent holds must be visible to
the model through the mechanism the model actually uses to find tools, in the
lane the run executes on, before the run's first attempt.

Argv validation remains the enforcement boundary. 0120 and 0130 stand unamended:
no classifier-derived or cached allow reaches `capability_run`, and a call whose
arguments fall outside the reviewed template is still refused.

The intent of freeing the call shape, so an agent can work without templates that
predict every argument, is recorded as direction rather than rejected. It is
gated on a precondition: a replacement boundary that satisfies 0120's threat
model, meaning an explicit flag policy or real filesystem and egress confinement,
established and proven before any relaxation. Until that exists, relaxation is
not on the table, and any proposal for it must supersede 0120 and 0130
explicitly.

## Consequences

- The story's capability work is a discovery and materialization change, not a
  permission change. It must prove the first viable call, not merely the absence
  of a mismatch.
- The prose rendering of reviewed patterns added by 97ded3746 is superseded by
  discovery and should be removed once discovery is proven, so two mechanisms do
  not claim the same job.
- Template authoring stays a real cost. Making reviewed templates easier to
  extend is legitimate follow-up work and does not require touching the gate.
- A future relaxation has a named precondition and an explicit supersession path,
  so the question does not get relitigated from scratch.
