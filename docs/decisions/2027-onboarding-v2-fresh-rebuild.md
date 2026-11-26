---
status: accepted
confirmed_by: "Ashirwad Shetye"
date: 2026-11-26
stories: []
supersedes: ""
---

# Onboarding v2 fresh rebuild

## Context

Two earlier onboarding implementations exist, and neither has merged:

- **The legacy-adoption task.** `archive/onboarding-v2-1-t1-2026-09` transplants the old `feat/v2-onboarding` archive as one large task. Its review asked for changes, and it is 178 commits behind main.
- **`feat/onboarding-ui-v2`.** A separate line of work that adds:
  - Slack channel join
  - a per-conversation allowlist
  - a completion reminder
  - critical-error recovery
  - Bedrock fixes

  It is about 150 commits behind main and carries five migrations.

The two branches use incompatible lifecycle tables and overlap in more than 40 files. Their governing decisions ("legacy adoption" and "migration baseline") were never merged to main, and their number collides with main's own decision 0162.

Main has since gained most of the infrastructure both branches built for themselves:

- the browser trust boundary
- model-credential preflight and Bedrock Runtime routing
- provider-account discovery and installation
- approver binding
- the responsive shell

## Decision

V2 first-agent onboarding is rebuilt fresh on current main as one Forge story of small tasks, each its own pull request. Both earlier branches are behaviour references only; no code is merged or transplanted wholesale. The flow reuses main's existing services and adds:

- **Exactly one generated onboarding migration**, owned by the story's data-model task. Later tasks add no onboarding migrations. If one becomes unavoidable, this decision is amended first.
- **Slack-only completion in this release.** Teams and the other providers stay setup-only.
- **A trigger-only per-conversation reply list**, consistent with decision 0090. It never blocks or drops messages.

## Consequences

- The earlier branches stay archived and are not merged. The unmerged "legacy adoption" and "migration baseline" decisions are not carried to main.
- More, smaller pull requests replace one very large one. Each is reviewed on its own.
- The existing web unit tests are reset to the three onboarding tests the spec names. Coverage for other web routes comes back in later work.
- Fresh Slack tenant proof stays a release gate, outside this story.
- The roadmap's earlier "onboarding wizard" item is replaced by this spec's story.
