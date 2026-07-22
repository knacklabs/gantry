# Permission engine redesign — empowered classifier + safety rails — goal prompt

Status: GRILL + DOUBLE-CRITIQUE + PLAN-VALIDATION HARDENED 2026-07-22 (Fable + Codex
critiques + a Codex plan-validation, all folded). **L2 sandbox-relaxation NOW FOLDED IN
(direct-relaxed is the universal default; `sandbox_runtime` opt-in) — needs re-validation.**
Supersedes
`permission-floor-and-promotion-goal-prompt.md`, folds `permission-simplification-goal-prompt.md`.
RCA: session scratchpad `git-permission-rca.md` (NOT in-tree — its incident claims
below are ASSUMPTIONS pending runtime re-verification, not repo-provable).

**Authorization is the SINGLE control, across TWO layers of one thesis** (Gantry's
permission + classifier IS the control; a second hard OS sandbox on top is redundant):
- **L1 — smart decision engine** (coordinator + rails + classifier + memory), below.
- **L2 — relax the redundant direct-mode sandbox** that currently overrides authorized
  work (the video-render block). Sequenced FIRST because it's the live unblock.

## Problem
The `auto` classifier is UNRELIABLE — uncached (re-judges every call,
`permission-classifier.ts:191`), nondeterministic, correctly fails to `ask`. Rules
need exact `RunCommand(...)` match; git is excluded from the read-only allowlist.
Telemetry is blind for `RunCommand` (`ipc-permission-telemetry.ts:59`). **Assumption
(RCA, re-verify at runtime):** the incident was authorization-prompting, not a
sandbox denial (all 5 calls resumed; no denial event; direct mode on).
**But a SEPARATE, PROVEN denial exists (this is L2):** the video-render failure — the
macOS command sandbox (Seatbelt) denies Chrome's Mach IPC (`bootstrap_check_in …
Permission denied`), blocking Remotion renders that worked before ~Jul 21. No Chrome
flag escapes it, and the agent's escape hatch is off "by policy." Per the vendor docs,
**Claude Code's sandbox is OFF by default** (permissions are the control) and
**DeepAgents has no OS sandbox at all** (backend-driven) — so Gantry's direct-mode
Seatbelt is redundant with its OWN permission+classifier and is precisely what blocks
legitimate work. `filesystem-sandbox.ts:68`.

## Core: EMPOWER the classifier (reliable, cached, guarded); rails are ask-floors.

## Layer 2 — relax the redundant direct-mode sandbox (authorization is the control)
Direct mode currently enables the SDK Seatbelt (fs + network + Mach/socket/Apple-Events
enforcement) ON TOP of Gantry's permission+classifier — redundant, and it blocks Chrome.
Relax it so authorization is the sole control, matching Claude Code's default (sandbox
off) and DeepAgents (no OS sandbox). Levers, least→most (all at
`runner-sandbox-provider.ts` / `filesystem-sandbox.ts` / `query-loop.ts` sandbox config):
1. **Re-enable the SDK escape hatch** (`allowUnsandboxedCommands: true` /
   `dangerouslyDisableSandbox`) — a Seatbelt-blocked command (Chrome) retries outside →
   through the coordinator. Likely fixes the video render alone.
2. **Relax the Seatbelt** for the ops browsers need: `allowAppleEvents`,
   `allowUnixSockets`, and/or `sandbox.filesystem.disabled` (fs layer off).
3. **End-state:** direct mode does NOT impose the hard sandbox — keep only a
   **credential denylist** (`sandbox.credentials`: `~/.ssh`, `~/.aws`, settings/creds)
   which blocks NOTHING legitimate; the permission engine + classifier is the authority.
**Direct mode (relaxed) is the DEFAULT across ALL deployments** (`runtime.sandbox.provider`
default = `direct` in `runtime-settings-defaults.ts:56` — keep + document it as the
universal default). **`sandbox_runtime` (the hard OS jail) becomes OPT-IN** — the optional inner jail a
deployment explicitly selects for defense-in-depth, an untrusted deployment boundary, or
multiple tenants packed in one container. Only direct-mode's POSTURE relaxes; the provider
is unchanged.

**Isolation model (why direct is right EVERYWHERE):** isolation = the DEPLOYMENT boundary —
the container/VM in cloud (the vendor-recommended pattern: run the agent inside a
locked-down container, NOT behind a redundant inner per-command sandbox), or the trusted
machine on a workstation. Control INSIDE that boundary = authorization (permission +
classifier + credential denylist). The inner SDK Seatbelt is redundant with BOTH boundaries
→ relaxed. **Multi-tenant caveat:** a container isolates the deployment from the host, NOT
tenants from each other — one-tenant-per-container makes the OS boundary sufficient;
multiple tenants in one container need per-agent isolation from the authorization/workspace
layer (the same per-agent scoping as decision memory) or a container-per-tenant.

SECURITY: this removes a REDUNDANT layer, not the authorization one; the credential
denylist + classifier remain the guards inside the deployment boundary.

## Architecture
1. **ONE host-side `coordinatePermissionDecision(input)`** — the single authority for
   rails → cache → classifier → human. NOT embedded in `evaluate`.
   - **Worker lanes** (SDK, DeepAgents shell/MCP/facade) reach it via existing
     authenticated IPC: `resolvePermissionIpcDecision` (`ipc-permission-classifier-decision.ts`)
     becomes the worker IPC ADAPTER that calls the coordinator.
   - **Inline lanes** (`gateCoreTool` `registry.ts:451/490`; `authorizeThirdPartyMcpTool`
     `inline-agent-loop-tools.ts:328/392` — shared by DeepAgents inline AND Anthropic
     SDK inline `inline-lane/index.ts:190`) call the coordinator DIRECTLY (in-host,
     no filesystem IPC — IPC would add no auth value).
2. **Deterministic rails stay SYNC + pure** (`ToolExecutionPolicyService.evaluate` +
   catalog + egress + guards). They run first, both as pre-filters and re-run inside
   the coordinator on every cache hit.
3. **Authority precedence (HARD): hard-deny → locked-preset → fixed-image restriction
   → reviewed selected-rule allow → coordinator (cache → classifier → human).** Today
   an `allow` returns BEFORE the locked check in every gate
   (`tool-permission-gate.ts:509/520/526`, DeepAgents `gantry-shell-tool.ts:191`,
   `third-party-mcp-gate.ts:87`, `gantry-facade-tools.ts:121`, inline `registry.ts:490`,
   `inline-agent-loop-tools.ts:354`). Reorder so NO coordinator allow can outrank a
   lock. **Fixed-image authority** (`hideAuthorityTools` = configured lock + per-run
   flag + `GANTRY_NO_PERMISSION_TOOLS`, `agent-spawn-preparation.ts:82`) is NOT in
   `resolveAgentLockStatus` (reads only `accessPreset`, `profiles.ts:79`) — add an
   authoritative per-run restriction to the coordinator input, validated host-side.
   **SDK `allowedTools`** is projected straight to the provider (`query-loop.ts:389`)
   — v1 REMOVES that silent auto-approval so every tool crosses the coordinator (or
   prove equivalent hard rails run first; "handle later" is insufficient).
   **Reviewed selected-rule allows** remain usable (incl. under locked mode per
   existing semantics): a rule hit is a deterministic standing authority the
   coordinator honors — it is NOT a classifier-cache entry (see memory kinds).

## Decision flow (inside coordinatePermissionDecision)
```
→ EXACT decision input (see effect key) — if input was sanitized/truncated/unavailable → ASK
→ parse (bash-command-parser). PARSE-FAIL / unsupported (env-assign, meta-exec, shell-
   expansion, >4096) / interpreter-with-string leaf (bash -c, sh -c, -e, node -e,
   python -c, xargs, find -exec/-delete) → ASK. Never cache, never classifier.
→ hard-deny / locked / fixed-image → DENY   (precede everything)
→ reviewed selected-rule allow → ALLOW       (standing rule authority)
→ DETERMINISTIC RAILS (ask-floors, re-run every hit): destructive catalog · EGRESS
   rail · secrets/protected · out-of-trusted-root · privilege → ASK/DENY
→ read-only fast-path (existing gate unchanged) → ALLOW
→ EXACT effect-cache hit (classifier-verdict kind only) → reuse
→ EMPOWERED CLASSIFIER (cache-miss) → safe: ALLOW · risk: ASK. Error/timeout →
   FAIL-CLOSED to ASK (one bounded retry). NEVER allow-on-error.
→ cache CLASSIFIER verdicts only, by versioned effect key. every ASK → remembered per its kind.
```

## Effect key (versioned, collision-resistant) — the hard input problem
- **Host discards the exact input before the decision**: `raw.toolInput` is
  redacted/truncated (500-char cap) at `ipc-parsing.ts:403` /
  `ipc-tool-input-sanitization.ts`. Distinct effects collapse before hashing.
  → the coordinator MUST receive an EXACT, non-persisted decision-input (or a
  host-built canonical effect) generated BEFORE telemetry/prompt sanitization; any
  sanitized/altered/missing input → ASK.
- **Canonical effect schema (versioned)** preserving: control-flow/grouping,
  quoting/glob semantics, authoritative effective cwd + repo/worktree identity,
  executable identity under the runner's real PATH, resolved symlink-aware existing
  & prospective targets, destination host for implicit ops (`git push origin`),
  normalized risk flags. `PermissionApprovalRequest` (`domain/types.ts:124`) carries
  none of these — new fields to plumb. Document the cwd invariant: SDK cwd = fixed
  workspace group dir (`query-loop.ts:368`); DeepAgents shell has separate
  `config.cwd` (`gantry-shell-tool.ts:255`).
- `bash-command-parser.ts` alone is insufficient (strips quotes `:289`, flattens
  `&&`/pipes `:348`, `argv.join(' ')` `:477`). Do NOT abstract targets to gain hits.

## Decision memory — FOUR distinct kinds, never conflated
1. **Classifier-verdict cache** — the ONLY thing keyed by effect hash + reused.
2. **Remembered denies** — surfaced with an ambient undo; list/revoke before ship.
3. **Trusted roots** — separate structure (owner-authored, canonical root, principal, revocation).
4. **Standing human grants ("Allow for future")** — separate; owner-authored.
**"Allow once" is per-interaction and is NEVER written to any reusable store.**
Dedicated versioned table (beside `permission_promotion_counters`; `permission_decisions`
is ID-keyed only, `permissions.ts:42`) with: stable row id, verdict/effect, decision
kind, effect-schema version, rail/catalog version, provenance (approving principal),
created/expiry, `revoked_at`, unique lookup identity, list/revoke repo methods.

## Trusted scope + approval UX
- **Learned roots only**; first op in a new root → ASK once → remembered (fixes
  `~/Workdir` being outside the agent workspace). Prompt options v1 =
  `[this folder] [once] [deny]` (DROP "whole area").
- Remembered denies surface undo; memory needs list/revoke before ship.

## Jobs (LOCKED with user) — same engine, standing grants inherited, pause-and-resume
- A job runs AS its agent through the SAME coordinator and **inherits the agent's
  standing set** ("Allow for future" + trusted roots + safe cached verdicts).
  "Allow once" is per-interaction → **never** arms a job. (This IS the mode rule —
  there is NO separate interactive/autonomous scoping; the once-vs-future choice is it.)
- **NEW: a `paused` JobRunStatus** (`job-types.ts:156` has none today; unattended ASK
  currently returns denial `permission-ipc-client.ts:183` / cancels
  `ipc-permission-classifier-decision.ts:152` and the run goes `failed`
  `execution-finalization.ts:152`). On a non-standing ASK the fenced run PAUSES;
  **owner approval RESUMES the SAME fenced run** (not a new run). Dedicated stage.
- **Job permission-ask routing**: surfaces BOTH durably in job status/metadata
  ("paused — needs approval: X") AND to the **owner-equivalent authority = the
  granting context's `controlApprovers`** (v1; a dedicated agent-owner is deferred).
  This channel is DISTINCT from the job's delivery route (which may be a group —
  wrong approver, would leak the action). A job with no delivery route still asks.
- **Owner authority v1 = `controlApprovers`** (`runtime-settings-types.ts:39`) — only
  they can author a standing grant. Known v1 limitation (accepted): a standing grant
  is agent-wide though authored by one context's approvers; a dedicated agent-owner +
  cross-context tightening is v2.

## Runtime-neutral coverage (prove the matrix, no bypass)
Route every wrapper to the coordinator exactly once: SDK worker
`createCanUseToolCallback`; DeepAgents worker shell/MCP/facade; inline `gateCoreTool`;
`authorizeThirdPartyMcpTool` (BOTH DeepAgents-inline AND Anthropic-SDK-inline — both
need tests). Remove SDK `alwaysAllowedTools`/`allowedTools` silent bypasses.
**PRESERVE** the intentional DeepAgents-shell absence (projected only under a
RunCommand rule + `sandbox_runtime`, `deepagents-shell-filesystem-guard.ts:125`) — call
the coordinator only after projection; do NOT add a shell lane.

## Consolidation + honest corrections
Demote the flaky classifier → cached+guarded+fail-closed at the coordinator. Absorb the
read-only allowlist unchanged (keep git reads OUT — pager-injection). Fix telemetry
(RunCommand text + ask reasons). **DROP the `select:`/`tool-search-decision.ts` fix**
(Codex: it does not reinterpret `select:`; move to observability, reproduce first).
Execution-gap RESOLVED by L2: direct-mode's Seatbelt relaxes to authorization-controlled
+ a credential denylist, so an ALLOW verdict actually executes (incl. Chrome/Remotion).
Add an execution test (public remote + non-protected dest + a Chrome/Remotion render) AND
assert the credential denylist still blocks `~/.ssh`/`~/.aws`/settings reads.

## Surface Impact Matrix (AGENTS.md:203 — required)
| Surface | Change |
|---|---|
| Runtime | new `coordinatePermissionDecision`; reorder authority precedence in all gates; remove SDK allowed/alwaysAllowed bypass |
| Rails | destructive catalog + egress rail + guards (new); read-only fast-path absorbed |
| Postgres projection | new decision-memory table + trusted-root store (+ revoke) |
| Jobs | new `paused` JobRunStatus + resume-same-run + pause-ask routing |
| Settings | standing-grant authority via existing `controlApprovers` (no new owner key v1); `direct` documented as the universal default provider, `sandbox_runtime` opt-in |
| IPC / runner | exact pre-sanitization decision-input path; effect fields plumbed |
| API / CLI / MCP | list/revoke decision-memory surface |
| Telemetry / audit | RunCommand command text + ask reasons |
| Sandbox (direct mode) | L2: relaxed to authorization-controlled — re-enable escape hatch + Seatbelt `allowAppleEvents`/`allowUnixSockets` or `filesystem.disabled`, keep credential denylist; `sandbox_runtime` provider unchanged |
| Docs | this doc + assumptions ledger |

## Staging (telemetry FIRST; each green; autoreview per commit)
0. Telemetry fix (RunCommand text + ask reasons) — makes flood/cache-hit measurable.
1. **L2 — relax direct-mode sandbox (INDEPENDENT of L1; unblocks video FIRST):**
   re-enable the SDK escape hatch + relax the Seatbelt to a credential denylist. Verify
   Chrome/Remotion renders AND `~/.ssh`/`~/.aws`/settings reads still blocked.
2. Coordinator skeleton + authority-precedence reorder (hard-deny/locked/fixed-image
   before any allow) + remove SDK bypasses + route ONE lane (SDK worker).
3. Deterministic rails (catalog + egress + guards + read-only fast-path + parse-fail/
   interpreter→ASK) sync, re-run every hit.
4. Exact pre-sanitization decision-input + versioned effect key + classifier-verdict cache.
5. Empowered classifier behind the coordinator, fail-closed, cache-miss only.
6. Decision-memory table (4 kinds, allow_once never cached) + trusted roots + list/revoke.
7. Learned-root ask-once + `[this folder][once][deny]`.
8. **Jobs: `paused` status + resume-same-run + pause-ask routing to `controlApprovers` + durable job status.**
9. Route remaining lanes (DeepAgents worker shell/MCP/facade, inline gateCoreTool,
   shared inline MCP) + prove the matrix.
10. Runtime smoke: clone/git/FS scenario + execution verify (public remote + Chrome render) + a job-pause/resume.

## Verify
tsc clean · sanitized/truncated input→ASK · parse-fail/interpreter→ASK · hard-deny/
locked/fixed-image precede any allow · SDK allowedTools no longer silently approves ·
exact effect-cache hit (2nd identical effect = no LLM) with rails re-run · egress rail
asks `curl -d @f host` · classifier error→ASK · allow_once never cached · learned-root
ask-once · per-lane coordinator-once matrix (SDK+DeepAgents worker+inline, shared inline
MCP) · job non-standing ASK → paused (not failed) → owner approval resumes SAME run,
routed to controlApprovers not delivery · **L2: ALLOW→runs incl. a Chrome/Remotion render
under relaxed direct mode, while the credential denylist still blocks `~/.ssh`/`~/.aws`/
settings reads** · existing permission suites green · autoreview clean per commit.

## Non-goals (v1)
REMOVING the `sandbox_runtime` provider (it stays for hard-isolation; only direct-mode
POSTURE relaxes) · DeepAgents shell lane · per-command user allowlist · ask-once-
on-every-unknown default · generalized op-shape cache · "whole area" breadth · `select:`
change · dedicated agent-owner / cross-context approver tightening (v2).

## Plan-validation gate (Codex twin, before build)
Re-confirm: **L2 — the direct-mode sandbox-relaxation seam (where the SDK sandbox/escape
hatch is configured in `query-loop.ts`/`runner-sandbox-provider.ts`/`filesystem-sandbox.ts`),
that re-enabling the escape hatch + a credential denylist actually lets Chrome/Remotion
render, that the credential denylist covers secrets, and that relaxation does NOT weaken
the `sandbox_runtime` provider**; coordinator entry + per-lane adapters; authority
precedence enforced in every gate; the exact pre-sanitization decision-input path; the
effect-schema fields & availability; the memory table + 4 kinds; the `paused`/resume
state machine; the matrix. (This doc already folded two full plan-validations; L2 is new.)
