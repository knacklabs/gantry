# Permission engine redesign — empowered classifier + safety rails — goal prompt

Status: GRILL + DOUBLE-CRITIQUE HARDENED 2026-07-22 (Fable + Codex, both agree).
Supersedes `permission-floor-and-promotion-goal-prompt.md`, folds
`permission-simplification-goal-prompt.md`. RCA: `git-permission-rca.md`.
Decision-ENGINE redesign, NOT a sandbox change.

## Problem (confirmed by both critiques)
User clones/git-ops/edits and is prompted constantly. AUTHORIZATION, not sandbox:
the `auto` classifier is UNRELIABLE — uncached (re-judges every call,
`permission-classifier.ts:191`), nondeterministic, and correctly fails to `ask`.
Telemetry is blind for `RunCommand` (`ipc-permission-telemetry.ts:59`) so the
incident was unanswerable. Codex confirms: **the only proven bug is repeated
authorization prompting — NOT a sandbox denial** (all 5 incident calls resumed;
no denial event). Direct mode already on; the SDK sandbox stays fail-closed and
independent (`filesystem-sandbox.ts:68`) — we do NOT touch it.

## Core decision (user): EMPOWER the classifier; rules are ask-floors. But the
architecture must be a proper host-side coordinator, not a seam insertion.

## Architecture (both critiques — this is the load-bearing change)
1. **Deterministic rails stay SYNC + pure.** `ToolExecutionPolicyService.evaluate`
   is a synchronous, dependency-free pre-filter that runs in the runner subprocess
   and is called 2–3× non-terminally (`tool-execution-policy-service.ts:177`). It
   is NOT the decision seam. Keep it pure rule/precheck. The destructive catalog +
   egress rail + guards live alongside it as sync ask-floors.
2. **NEW async host-side DECISION COORDINATOR** = the single authority for
   cache → classifier → human, reached by every lane via authenticated IPC (this
   is where `permission-classifier.ts` already lives, host-side, with LLM/DB/
   telemetry). The analyzer is NOT embedded in `evaluate`.
3. **HARD ORDERING — locked/fixed-image restrictions + hard-denies PRECEDE any
   cache/classifier allow.** Today `tool-permission-gate.ts:520/526` returns an
   `allow` BEFORE the locked-preset check — safe only because `allow` means a
   narrow reviewed rule. A broad classifier-allow there would outrank locked mode.
   The coordinator must resolve hard-deny/locked FIRST, then cache, then classifier.

## Decision flow (at the coordinator, all lanes route here on rule-miss)
```
op → parse (bash-command-parser). PARSE-FAIL / unsupported (env-assign, meta-exec,
      shell-expansion, >4096 chars) / interpreter-with-string leaf
      (bash -c, sh -c, -e, node -e, python -c, xargs, find -exec/-delete) → ASK. Never cache, never classifier.
    → hard-deny / locked / fixed-image restriction? → DENY (precedes everything)
    → DETERMINISTIC RAILS (ask-floors, re-run on EVERY cache hit):
        destructive catalog · EGRESS rail · secrets/protected · out-of-trusted-root · privilege → ASK/DENY
    → read-only fast-path (existing proven gate, unchanged) → ALLOW
    → EXACT effect-cache hit? → reuse verdict (rails already re-ran above)
    → EMPOWERED CLASSIFIER (host, cache-miss only) → safe: ALLOW · risk: ASK
        classifier error/timeout → FAIL-CLOSED to ASK (one bounded retry). NEVER allow-on-error.
    → cache the verdict by versioned effect key. every ASK → remembered (scoped, below).
```

## The hardening LOCKS (both critiques — non-negotiable)
1. **Fail-closed to ASK on any classifier failure** (unconfigured/timeout/abort/
   parse/validation). Current code already does this (`permission-classifier.ts:167/215/597`);
   preserve it. Auto-allow-on-error = availability→authorization bypass. Allow
   WITHOUT the LLM only on a POSITIVE deterministic proof (read-only fast path).
2. **Versioned, collision-resistant EFFECT key — not raw argv, not generalized
   op-shape.** `bash-command-parser.ts` alone is insufficient (strips quote context
   — `chmod 0644 '*.pem'` == `*.pem`; flattens `&&`/`||`/pipes/subshells; only
   generalizes URLs/hex-refs). Define a VERSIONED canonical effect schema
   preserving: control flow/grouping, quoting/glob semantics, cwd/repository
   identity, resolved targets (against real parents; symlink-aware), network host,
   executable identity, risk-relevant flags. Unsupported parse → ASK. Rails re-run
   before every hit. Do NOT abstract mutation/destructive targets to gain hits.
3. **EGRESS rail** (new sync guard). Destruction/secret/scope/privilege miss quiet
   exfiltration: `curl -d/-T/-F @file host`, `wget --post-file`, `scp`/`rsync` to
   remote, `git push` to non-remembered remote → ASK once, keyed on destination
   host. Silent-allow scoped to read-only OR write-in-trusted-root-no-egress.
4. **Coordinator, not `evaluate`; hard-deny/locked precede allow** (Architecture #2/#3).
5. **Jobs inherit the agent's STANDING permission set (one allow list per agent).**
   A job runs AS its agent; no separate mode-scoping. The once-vs-future choice IS
   the job-inheritance control: **"Allow for future" = standing** (owner-authored,
   inherited by the agent's jobs — trusted roots + safe verdicts are all standing,
   so jobs just work); **"Allow once" = per-interaction** (a job that hits it
   PAUSES — it cannot inherit a one-time grant). Standing grants require **owner
   authority** — a non-owner (group member / prompt-injected message) cannot mint a
   standing grant that jobs then inherit (cross-conversation propagation guard,
   `channel-prompts.ts:396`). Key memory by app + stable agent ID + decision kind +
   **approving principal** + analyzer/catalog **version** + effect hash. Trusted
   roots stored SEPARATELY from classifier verdicts; destructive/privileged
   approvals never become a generic classifier-cache allow.

   **Job permission-ask routing.** A job that reaches ASK (a non-standing op) does
   NOT stall and does NOT silently run — it PAUSES and surfaces the pending action
   BOTH (a) durably in the job's status/metadata (job list: "paused — needs
   approval: X"; never lost) AND (b) to the OWNER via the owner's conversation with
   the agent. The approver is the OWNER (the only one who can mint a standing grant)
   — this channel is DISTINCT from the job's delivery route (which may be a group
   channel — wrong approver, and would leak the pending action). A job with no
   delivery route still asks the owner. On owner approval → standing (or
   once-for-this-run) → the job resumes.

## Deterministic rails (detail)
- **Destructive catalog** = a false-allow REDUCER for known scary shapes, NOT the
  guarantee (guarantee = parse-fail/interpreter→ASK + scope/egress-bounded silent-
  allow). Does not exist yet (the YOLO denylist is small/optional — not this).
  Shapes: `rm -r/-f`, destructive `--force`/`-f`, `git reset --hard`/`push --force`/
  `clean -fdx`/`checkout -- .`/`branch -D`/`stash clear`, `drop`, `truncate`, `dd`,
  `mkfs`, overwrite `>` of existing, `sed -i`, `chmod/chown -R`, `rsync --delete`,
  `find -delete`, `tee` over existing. Match → ASK once (re-evaluated every time).
- **Read-only fast-path** = absorb the EXISTING gate UNCHANGED (exact executable,
  single leaf, no expansion). Do NOT add git reads — config-injected pagers
  (`git -c core.pager=`, `GIT_PAGER`) execute code; the existing test deliberately
  excludes `git status/log/diff/show` (`auto-permission-read-only-gate.test.ts:102`).
- **Effect model gap**: today git clone/pull/commit classify as bare `execute` with
  NO target (`tool-execution-policy-service.ts:502/521`), and the request lacks
  cwd/repo identity (the builder doesn't even set the available `agentId`,
  `:72/:157`). Deriving cwd-aware git effects (implicit writes/network/hooks) is
  net-new work in this redesign.

## Trusted scope + approval UX
- **Learned roots only** — nothing trusted by default; first op in a new root →
  ASK once → remembered (fixes repos in `~/Workdir` being outside the agent workspace).
- **Prompt options v1 = `[this folder] [once] [deny]`** (DROP "whole area" — over-grants).
- Remembered **denies** surface an ambient notice + undo; decision memory needs a
  list/revoke surface BEFORE ship (no silent permanent self-DoS).

## Runtime-neutral coverage (Codex #4 — there is NO single boundary today; prove the matrix)
Route every permission-bearing wrapper to the coordinator exactly once, no bypass:
SDK worker `createCanUseToolCallback`→`resolvePermissionIpcDecision`; DeepAgents
worker shell `createGantryShellTool`; DeepAgents worker MCP/facade wrappers
(`third-party-mcp-gate.ts`, `gantry-facade-tools.ts`); inline `gateCoreTool`
(`registry.ts:451/490` — it currently OMITS the classifier); DeepAgents inline MCP
`authorizeThirdPartyMcpTool`. Handle bypasses: SDK `alwaysAllowedTools`
(`tool-permission-gate.ts:509`) + `allowedTools` silent fast-path (`query-loop.ts:388`).
**PRESERVE** the intentional absence of a DeepAgents direct/inline RunCommand lane
(shell not projected unless a rule exists + `sandbox_runtime`) — do NOT add one;
that's a separate sandbox-authority decision.

## Decision-memory store (Codex #7 — net-new; existing tables not reusable)
Dedicated, versioned table beside `permission_promotion_counters` (the nearest
seam: app+agent-folder+key, but stores counts not verdicts). Keyed by app + stable
agent ID + decision kind + exec mode + approving principal + analyzer/catalog
version + effect hash. Trusted roots in a separate structure.

## Consolidation + honest scope corrections
- Demote the flaky classifier → cached (effect key) + guarded + fail-closed, at the coordinator.
- Absorb the read-only allowlist unchanged. Fix telemetry (RunCommand text + ask reasons).
- **DROP the `select:`/`tool-search-decision.ts` fix** — Codex proved it does NOT
  reinterpret `select:`; it only picks tool-search mode. Move that to observability;
  reproduce the upstream misclassification before touching it.
- **Sandbox stays independent.** ALLOW ≠ sandbox bypass. The incident is
  authorization-prompting only. Add an execution test (public remote + non-protected
  dest works) AND separately assert precise sandbox denials — do not conflate.

## Staging (telemetry FIRST; each leaves tree green; autoreview per commit)
0. **Telemetry fix** — redacted RunCommand command text + ask reasons. Makes flood-
   reduction + cache-hit-rate measurable before any behavior change.
1. **Async decision coordinator skeleton** (host) + route ONE lane (SDK worker) to
   it; hard-deny/locked precede allow; classifier moved behind it, fail-closed.
2. **Deterministic rails** — destructive catalog + egress rail + guards + read-only
   fast-path (absorbed) + parse-fail/interpreter→ASK, sync, re-run on every hit.
3. **Versioned effect key + exact effect-cache** (decision memory table) + rails-recheck.
4. **Learned-root ask-once** (`[this folder][once][deny]`) + memory keyed by kind/
   mode/principal/version + revoke surface. Trusted roots separate from verdicts.
5. **Route remaining lanes** (DeepAgents worker shell/MCP/facade, inline gateCoreTool,
   inline MCP) to the coordinator; prove the matrix; handle alwaysAllowed/allowedTools.
6. Runtime smoke: clone/git/FS scenario end-to-end + execution verify (public remote).

## Verify (real)
tsc clean · parse-fail/interpreter→ASK · exact effect-cache hit (2nd identical
effect = no LLM) with rails re-run · egress rail asks on `curl -d @f host` ·
classifier error→ASK · hard-deny/locked precede any allow · learned-root ask-once ·
interactive grant does NOT arm autonomous · non-owner group op asks · remembered-deny
undo · per-lane coordinator-reached-once matrix (SDK+DeepAgents+inline) · ALLOW→runs
(public remote, non-protected dest) with sandbox denials asserted separately ·
existing permission suites green · autoreview clean before each commit.

## Non-goals
Sandbox provider change · adding a DeepAgents RunCommand lane · per-command user
allowlist · ask-once-on-every-unknown default · generalized op-shape cache ·
"whole area" breadth (v1) · `select:` behavior change · multi-tenant requester-
scoping beyond principal/owner-initiation (v1).

## Plan-validation gate (Codex twin, before build)
Confirm the coordinator IPC contract per lane + the exact effect-schema fields +
the memory table shape + that hard-deny/locked precede allow in every gate + the
execution-gap resolution. Both critiques already ran; this is the pipeline's formal pass.
