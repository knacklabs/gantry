---
name: preexisting-egress-noproxy-test-failure
description: "agent-runner-ipc NO_PROXY test fails on feat/agent-access-simplification due to in-progress egress refactor, not your changes"
metadata: 
  node_type: memory
  type: project
  originSessionId: 43aa450f-3e82-4810-baf4-f919f759f5e0
---

On branch `feat/agent-access-simplification`, `npm run test:unit` has one
pre-existing failure unrelated to permission/UX work:

- `apps/core/test/unit/runner/agent-runner-ipc.test.ts > passes only broker-safe
  values into the Agent SDK env` — expects `NO_PROXY` to contain github.com hosts
  (`github.com`, `.github.com`, `api.github.com`, …) but the code only emits
  loopback (`127.0.0.1`, `localhost`, `::1`).

Cause: the branch's **uncommitted** egress refactor in
`apps/core/src/adapters/llm/anthropic-claude-agent/runner/runtime-env.ts` changed
`applyAgentEgressNoProxyEnv(sdkEnv, { externalBypass: false })` and dropped the
github-host NO_PROXY copy; the test wasn't updated. Confirmed pre-existing by
`git stash`-ing all tracked changes → the test passes at HEAD. The egress/network
files (`runtime-env.ts`, `sdk-sandbox-network-gate.ts`, `egress-gateway.ts`) were
already `M` in git status before the permission-UX work started. Don't mistake it
for a regression. Also note the file-size budget gate
(`check_task_completion.py`) is already red for pre-existing over-budget files
`agent-spawn.ts` (889) and `ipc-admin-handlers.ts` (908). Related:
[[preexisting-test-failures-credential-branch]].
