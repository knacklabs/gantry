---
name: flaky-agent-runner-heartbeat-test
description: "agent-runner-ipc heartbeat test times out under load in verify.py but passes in isolation — flaky, not a regression"
metadata: 
  node_type: memory
  type: project
  originSessionId: f4873c6c-d8af-4bc7-8fde-2298d6c64d2d
---

`apps/core/test/unit/runner/agent-runner-ipc.test.ts > emits scheduled job heartbeat runtime events during quiet query windows` spawns a real runner subprocess and waits ~25s for a JOB_HEARTBEAT frame. Under CPU contention (e.g. `python3 .codex/scripts/verify.py` running build+typecheck+tests back-to-back, or other concurrent npm work) the spawned runner is starved and the wait times out ("runner timed out"; the test file's reported duration balloons to ~580s). It passes reliably in isolation and in standalone `npm test` / `npm run test:unit` (3885/3885).

**Why:** verify.py's tests stage (`npm test`) can spuriously fail ONLY on this test when the machine is loaded; `.factory/verify.json` then has `ok:false`, which also fails `validate_artifacts.py`.

**How to apply:** treat a lone failure of this test under verify.py as environmental, not a regression — re-run `npx vitest run apps/core/test/unit/runner/agent-runner-ipc.test.ts` (or `npm test`) on an idle machine to confirm green, then re-run verify.py. Related: [[deepagents-agent-engine-branch]], [[preexisting-test-failures-credential-branch]].
