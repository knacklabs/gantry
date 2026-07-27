---
status: accepted
confirmed_by: "vrknetha"
date: 2026-07-27
---

# LAT-GATE-0 Revised Client Signoff

## Context
`docs/decisions/0064-client-signoff.md` accepted the original LAT-GATE-0
prerequisite scope as three fixture repairs. Forge contradiction signal
`S-0001-8d39` invalidated the job-lifecycle fixture premise on macOS: the
packaged runner strips `HOME`, so `allowedOuterSandboxClaudeExecutable` rejects
the fake executable under `fakeHome/.local/bin/claude`.

Changing that executable-trust boundary would require production sandbox/runtime
scope. The user explicitly authorized autonomous all-phase delivery with reviewed,
green, merge-ready PRs, but did not authorize production executable-trust changes
inside this prerequisite fixture repair.

## Decision
Revise LAT-GATE-0 to repair exactly two fixtures: the DeepAgents RunCommand wait
and the MCP inventory/audit hot-path reviewed-capability fixture.

The job-lifecycle E2E must return to unchanged baseline and remain a required
evidence gate in a disposable Linux/CI-parity Node 25 worktree or container. The
macOS host result is documented as a platform mismatch, not as a fixture defect.

This decision does not authorize executable-trust, sandbox, `HOME`, packaged
runner, provider, scheduler, or job-lifecycle fake-Claude production changes.

## Consequences
The LAT-GATE-0 implementation remains test-only and production source remains
out of scope. The implementer may edit only the DeepAgents and MCP fixture files,
plus restore any job-lifecycle test/helper changes made in this prerequisite
worktree back to baseline.

Linux/CI-parity Node 25 hermetic job E2E evidence is recorded from unchanged
base `5fff01d0f` in a Node 25 container with a container-local Postgres proxy:
1 file / 1 test passed, 0 skipped, 38.03s. The branch cannot be PR-ready unless
that Linux/CI-parity gate is repeated for the branch, local
integration/Postgres/hot-path gates pass, Ponytail and autoreview are clean, CI
is green, and the checkout-bound KnackLabs smoke passes.

Forge acceptance of this revised signoff is recorded by this accepted decision.
It does not bypass decomposition, verification, review, PR-ready, CI, Linux E2E,
or checkout-bound smoke gates.
