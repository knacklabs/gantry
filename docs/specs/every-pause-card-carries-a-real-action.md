---
slug: every-pause-card-carries-a-real-action
title: CARDFIX-1 — Every pause card carries a real action
status: confirmed
saved: 2026-08-31T10:45:11+00:00
---

# CARDFIX-1 — Every pause card carries a real action

Story: CARDFIX-1
Inputs: live incident 2026-08-31 (job `card-check-2`): a piped `RunCommand` was correctly refused for autonomous per-leaf authorization (decision 0134), the run paused, and the owner received a plain-text "Setup needed" message with an empty action surface — no buttons on any provider. `formatSchedulerSetupStory` (`apps/core/src/application/jobs/scheduler-setup-story.ts`) returns text only; no `actionAffordances` are ever attached to pause/setup deliveries. Owner directive: fix the class once, provider-neutrally — not per provider.

## Why

A paused job that tells its owner "this job paused" and offers nothing to press is a dead end: the owner cannot resume, cancel, or reformulate from the message, and the job sits paused until someone finds a CLI. Every other card in the product (permission cards, setup cards, job result cards) carries actions built in the neutral layer and rendered by each provider's existing affordance renderer. Pause stories must join that contract.

## Behaviour

- Every pause/setup story delivery (`preflight_setup`, `final_setup`, `permission_denied`, `permission_timeout`, `transient_permission`, `partial_recovery`) carries at least one real, working action affordance, attached in the neutral layer so all providers render it through their existing action renderers.
- Ruled action set (owner, 2026-08-31): a compound-command pause card offers **Allow once for this run** (re-runs with a one-time interactive ask-and-wait approval; no durable grant) and **Pause job**. Other blockers offer their existing grantable setup actions plus Pause job; every pause card has at least one action.
- For a compound-command denial (0134), a durable grant is never offered; 'Allow once' authorizes exactly one run interactively.
- Actions route through the existing neutral message-action router (`channel-message-action-router.ts`) — no provider-specific handlers.
- Existing per-provider renderers are not forked: the affordances flow through `actionAffordances` exactly like scheduler cards (SCHED-4B) do.

## Acceptance criteria

- AC1: every `formatSchedulerSetupStory` delivery reaches the channel with at least one working action affordance, on all four providers, via the neutral affordance path; no pause/setup message is ever sent action-less.
- AC2: the compound-command denial card offers the grill-ruled action set and never a durable-grant button (0134 holds).
- AC3: tapping each offered action performs its effect through the neutral router (unit-tested per action; provider render covered by the existing per-provider affordance tests).
- AC4: existing unit and Postgres integration suites pass; tsc and check:architecture green.

## Not in scope

Reworking 0134 policy, the ask-and-wait card lifecycle (JOBPERM-3), and the six graceful-waiting findings (lost retry timer, unregistered-channel drops, stale-prompt feedback, waiting-job reminders, expired-row aging, provider-unknown log) — those are GRACE-1, the story that follows this one.
