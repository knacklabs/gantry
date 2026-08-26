---
status: proposed
confirmed_by: ""
date: 2026-08-26
stories: [TEAMS-E2E-1, PKG-1]
---

# Agent E2E: fixture tier blocks PRs, real-tenant tier runs nightly (amends 0044)

## Context

Decision 0044 keeps the agent-e2e merge bar PR-blocking on ephemeral runners.
In practice PR CI excludes E2E and the nightly real-model lane self-skips without
secrets. Teams-first positioning requires proof against a real Microsoft 365
tenant, which needs inbound webhook reachability from Microsoft and tenant
secrets — neither is available to fork PRs, and neither belongs in the ordinary
merge gate.

## Decision

Agent E2E is two-tier. Tier 1, fixture/adapter-contract E2E (hermetic transports,
real runtime), is a required PR check and blocks merge. Tier 2, the same
scenarios against real tenants and a deployed endpoint (Slack, Teams), runs
nightly or on a trusted label from same-repo branches; failure pages the story
owner and blocks the next release tag, not the PR. Decision 0044's merge-bar
intent is satisfied by Tier 1; Tier 2 is the release bar.

## Consequences

- TEAMS-E2E-1 ships both tiers; the Teams video path is proven by Tier 2.
- Release tagging (PKG-1) checks the last Tier 2 run is green.
- Nightly self-skip on missing secrets is replaced by an explicit failure on the
  release-bar lane.
