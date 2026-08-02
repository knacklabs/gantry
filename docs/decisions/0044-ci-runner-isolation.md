---
status: accepted
confirmed_by: "vrknetha"
date: 2026-07-24
---

# CI Runner Isolation

## Context

The 2026-07-24 security audit rated as **Critical** that public pull-request
code executes on a persistent self-hosted CI runner with Docker, `sudo`, and a
secret-bearing real-model step (`.github/workflows/ci.yml`, no `permissions:`
block). A persistent runner can be durably compromised by untrusted PR code.
Competing constraint: the standing merge bar (E2E-3, user directive) requires
agent-e2e to be a PR-blocking check, so the audit's literal suggestion —
moving the real-model lane post-merge — conflicts with it.

## Decision

All CI lanes, including agent-e2e, run on GitHub-hosted ephemeral runners
(`ubuntu-latest`; free for public repos). The real-model step keeps
`E2E_MODEL_API_KEY` but auto-skips when the secret is absent (fork PRs receive
no secrets); same-repo PRs keep the full e2e merge gate. Every workflow
declares explicit minimal `GITHUB_TOKEN` permissions (`contents: read` or
tighter). No `pull_request`-triggered job may use a self-hosted label.

## Consequences

- Persistent-runner compromise class eliminated; the e2e merge bar survives.
- Same-repo PRs still expose the model secret to PR code — accepted:
  contributors have write access anyway and the runner is ephemeral.
- GitHub-hosted runners are smaller/slower than the current host; lanes may
  need timeout tuning or splitting — never a fallback to the persistent runner.
- Rejected: e2e post-merge (breaks the merge bar); ephemeral self-hosted
  (runner-lifecycle tooling we don't have).
