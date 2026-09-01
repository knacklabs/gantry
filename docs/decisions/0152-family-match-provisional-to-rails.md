---
status: proposed
confirmed_by: ''
date: 2026-09-01
stories: [CARDSIMPLE-1]
---

# Family Matches Are Provisional To Deterministic Rails

## Context

`RunCommand(<literal argv0> *)` grants reduce repeated prompts by authorizing a
command family, but the arguments in a later invocation were not reviewed when
the family was granted. Treating that broad match like an exact reviewed rule
would let it bypass the deterministic destructive, privileged, egress, and
protected-path rails under the ordering established by 0040.

## Decision

A literal-argv0 family match is provisional: the coordinator evaluates the
existing deterministic rails against the exact current command before honoring
the match. If a rail requires approval, the request carries no durable rule
suggestion and offers only Allow once or Cancel. Exact reviewed rules and
reviewed semantic-capability grants retain 0040's existing early return.

This narrowly amends 0040 only for literal-argv0 family matches.

## Consequences

- A later safe invocation in a granted family proceeds without another prompt;
  a risky invocation remains visible and cannot widen durable authority.
- 0121 remains unchanged: autonomous evaluation stays deterministic and
  classifier-free. 0144 and JOBPERM-2 remain unchanged: the existing ask/wait
  and once-grant path handles a family rail hit because no persistable
  suggestion is attached.
- 0134 remains unchanged: pipes are never durably suggested, while safe
  control-flow compounds are authorized per leaf.
- Exact reviewed rules, semantic capabilities, and pinned `local_cli` readiness
  matching keep their existing behavior.
