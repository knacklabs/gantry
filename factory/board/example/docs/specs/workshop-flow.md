---
slug: workshop-flow
title: Workshop flow
status: confirmed
saved: 2026-08-05T00:00:00+00:00
---

# Workshop flow

## Why

Coordinators need one dependable view of which repair work can start and which
customer handoffs are waiting on unfinished work.

## Behaviour

The roadmap separates workshop preparation from customer delivery. Independent
preparation can start immediately, while a handoff that depends on unfinished
repair work remains visibly blocked by the named repair story.

## Acceptance criteria

- The ready frontier contains more than one startable story.
- A blocked handoff names the unfinished repair story it requires.
- Every story belongs to one of the two workshop epics.
