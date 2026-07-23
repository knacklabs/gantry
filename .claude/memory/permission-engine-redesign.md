---
name: permission-engine-redesign
description: Live git/sandbox pain root-caused to authorization (not sandbox); locked redesign of the permission DECISION ENGINE
metadata: 
  node_type: memory
  type: project
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

**Trigger (2026-07-22):** user's live gantry agent kept prompting on `git clone`/pull/update and
seemed "sandbox blocked." Codex RCA verdict: it's an **AUTHORIZATION** problem, **NOT the sandbox**.
Direct mode was already on and is NOT the lever.

**Root cause:** durable rules need EXACT `RunCommand(...)` match (only one narrow git rule live), git is
deliberately excluded from the deterministic read-only allowlist (ls/cat/grep…), and `auto` mode's LLM
classifier is NONDETERMINISTIC (allows or asks; asks on failure). The "sandbox.blocked" event was a
mislabeled SUCCESS (network-token coupling REMOVED Jul 18, commit 88c288d20). Telemetry is blind — it
captures command text only for `Bash`, not canonicalized `RunCommand` (`ipc-permission-telemetry.ts:59`).

**direct vs sandbox_runtime:** global `runtime.sandbox.provider`, restart-required, not per-agent.
`direct` = outer runner direct BUT the Anthropic SDK sandbox still enforces fs (protected-paths only) +
network (denylist + must resolve public DNS). `sandbox_runtime` = whole runner in an OS jail (seatbelt/
bubblewrap), SDK fs sandbox OFF. Both still sandbox tools; "direct" ≠ "no sandbox".

**LOCKED design (user rejected allowlists — "what's the point of a classifier if I edit settings every
time"):** refactor the permission DECISION ENGINE, NOT the sandbox:
1. **Deterministic RISK ANALYZER** (generalize the git gate) — auto-allow provably-safe ops from
   semantics (workspace containment, known-host+https+hooks-off git, public-API vs credential network,
   non-destructive commands). No prompt, no LLM, no config. Same deterministic-first / no-per-request-LLM
   principle as the Observer value gate.
2. **Decision MEMORY** — remember by operation-SHAPE, reuse; asked once, ever; self-populates.
3. **LLM classifier shrinks to the rare novel/ambiguous case**, cached.
4. **Ask threshold = "only genuine risk, ask once"** — destructive (rm -rf, force-push, drop), writes
   OUTSIDE workspace, credential/secret access, unknown remote host.
Also fix telemetry (redacted RunCommand command text + preserve classifier ask reasons) and stop
reinterpreting `select:` shell text as ToolSearch.

**Key seams:** `tool-rule-matcher.ts`, `auto-permission-read-only-gate.ts` (extend→risk analyzer),
`permission-classifier.ts`, `tool-permission-gate.ts`, `tool-execution-policy-service.ts`,
`sdk-sandbox-network-gate.ts`, `filesystem-sandbox.ts`, `ipc-permission-telemetry.ts`. Builds on
[[auto-permission-trust-pause]] + [[auto-permission-mode-direction]] + [[no-timed-grant-permission]].
Full docs: scratchpad/permission-engine-redesign.md + git-permission-rca.md.

**UPDATE 2026-07-22 (grill + double critique + plan-validation COMPLETE; ONE goal doc =
docs/architecture/permission-engine-redesign-goal-prompt.md).** Design now has TWO layers of
one thesis (authorization is the SINGLE control):
- **L1 decision engine:** ONE host `coordinatePermissionDecision` (NOT at `evaluate`); worker
  via `resolvePermissionIpcDecision` adapter, inline direct; authority precedence hard-deny→
  locked→fixed-image→reviewed-rule→coordinator; EXACT versioned effect-key cache (allow_once
  NEVER cached); decision-memory 4 kinds; fail-closed classifier; learned-roots; jobs inherit
  standing grants + new `paused` JobRunStatus (resume-same-run) + ask→controlApprovers(owner v1).
- **L2 (build FIRST — unblocks live video bug):** relax the redundant direct-mode SDK sandbox.
  **NO SDK sandbox anywhere** (user-confirmed): direct = SDK sandbox OFF; `sandbox_runtime`
  (opt-in) = OS jail is the boundary. **direct = universal default everywhere.** Isolation =
  the DEPLOYMENT boundary (container/VM in cloud, trusted machine on workstation); control =
  authorization + a thin credential denylist. Levers: escape-hatch → Seatbelt relax → cred-
  denylist-only. Seam: query-loop.ts/runner-sandbox-provider.ts/filesystem-sandbox.ts.
- **The live pain = VIDEO RENDER:** macOS Seatbelt denies Chrome's Mach IPC (`bootstrap_check_in`)
  → Remotion can't render. Skills were fine. L2 fixes it. `filesystem.disabled` won't (Mach≠fs);
  the fix is likely the escape-hatch or `allowAppleEvents`/`allowUnixSockets`.
- Refs: Claude Code sandbox OFF by default + DeepAgents no OS sandbox validate relaxing.
- STATUS: L2 re-validation running (Codex task-mrw6c8k0-je73gg); on resume, fold its findings →
  BUILD (L2 first). Build routing (symphony-forge factory gate vs goal-pipeline) = ask user first.
Separate small fix (NOT folded): skill-catalog no-budget (agent-prompt-capability-guidance.ts
omits 5/11 skills via byte budget; skills are files → list all names, load bodies on demand).

**2026-07-22:** design + RCA COMMITTED: `docs/architecture/permission-engine-redesign-goal-prompt.md` (plan-validation-hardened working copy committed d0dd7619) + `docs/architecture/git-permission-rca.md` (see [[symphony-forge-migration]]).
