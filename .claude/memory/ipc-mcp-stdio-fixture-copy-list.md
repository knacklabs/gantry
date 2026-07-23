---
name: ipc-mcp-stdio-fixture-copy-list
description: Spawned-runner test sandboxes copy source files — shared/ is now copied wholesale (root-cause fixed 2026-07-22); NON-shared dirs are still hand-enumerated in both suites
metadata: 
  node_type: memory
  type: reference
  originSessionId: 6c9e273e-e330-47f5-8b1a-6cb51d1e0af1
  modified: 2026-07-22T15:10:42.275Z
---

Two spawned-runner suites (`apps/core/test/unit/runner/ipc-mcp-stdio.test.ts`
and `agent-runner-ipc.test.ts`) sandbox the runner by copying source files.
A module reachable from the runner via a *value* import (`import type` is
elided by tsx) that is missing from the sandbox kills the subprocess with
ERR_MODULE_NOT_FOUND — symptom: ~40+ tests per suite fail as UNIFORM ~19s IPC
timeouts; typecheck and in-process tests never catch it.

**2026-07-22 root-cause fix (PAY-1)**: the hand-maintained `shared/` lists (96
copy statements across both files) were replaced with one recursive
`fs.cpSync` of the whole `apps/core/src/shared/` tree — new shared modules can
no longer break the sandbox. Forge lesson `runner-sandbox-copy-lists` ledgered.

**Residual risk**: runner-reachable modules in OTHER dirs (e.g.
`application/guided-actions/*`, adapter singles like `agent-capabilities.ts`)
are still hand-enumerated in BOTH files — adding a new value-import from the
runner into a non-shared dir still needs copy entries in both suites (or
extend the wholesale-copy treatment to that dir). Uniform-timeout signature ⇒
check the sandbox copy set FIRST. Related: [[symphony-forge-migration]].
