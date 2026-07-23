---
name: perm-1-shipped-pr271
description: "PERM-1 permission-engine slice-1 shipped as PR #271; review caught real bugs; PERM-2 scope carve-outs"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6c9e273e-e330-47f5-8b1a-6cb51d1e0af1
  modified: 2026-07-23T07:41:23.743Z
---

PERM-1 (permission engine deterministic-gate slice) shipped as **PR #271** (knacklabs/gantry), merge human-gated. Branch `feat/PERM-1-git-deterministic-gate` merged origin/main first to clear the PAY-1 squash artifact (diff was 24k phantom deletions → clean 50 files/+2824/-892 after merge). Same merge-then-clean needed for any branch cut off the pre-merge PAY-1 base (CAP-1 too).

**The 3-pass autoreview caught REAL bugs** (validates [[holistic-bug-framing]] / the "are we finding bugs" question — YES):
- allowMachLookup `['*']` (every macOS XPC/Mach service) → narrowed to `com.apple.SystemConfiguration.configd` (proven media-render service).
- Trusted-root containment (`permission-trusted-paths.ts`) was lexical-only → symlink/bare-relative/slashless-option escapes. Fixed by canonicalizing symlinks (`fs.realpathSync` on longest existing ancestor) + checking EVERY option-value/positional token (not a path-guess heuristic — that heuristic leaked 3 times across review rounds).

**PERM-2 scope carve-outs (NOT PERM-1 defects, encoded deliberately in tests):** rails do NOT emit a git ALLOW — git returns undefined and falls to the human tail (`permission-deterministic-rails.test.ts` "keeps git out"); the zero-prompt trusted-root ALLOW is PERM-2's decision-memory riding on PERM-1's deny-floor. The in-coordinator cache is PERM-2 (lives in the injected tail today). Residual: shell glob expansion (`git -C esc*`) not expanded pre-check — defense-in-depth only since git routes to tail.

**Two regressions fixed + signal-resolved:** S-0008-873f (rails ASK returned terminal deny → now railOutcome routes ASK to tail), S-0008-4886 (inline records persisted null runId → thread correlationRunId ?? run.runId). S-0007-cda8 = pre-existing D-0007 (live-admission), not a regression.

Codex reviewer sandbox can't write /tmp or run vitest — authored final review JSONs from its verified verdicts. See [[merge-gate-discipline]], [[e2e-required-for-merges]] (PERM-1 carries coordinator-authority.agent-e2e.test.ts).
