# Permission engine redesign — empowered classifier + safety rails — goal prompt

> **Implementation status (2026-07-28): SHIPPED on `main`.** The core redesign
> landed through PERM-1–PERM-4, with follow-up correctness and usability
> hardening in PERM-6–PERM-8 and the Gantry-native tool risk mapping. The
> current contract is recorded immediately below. The remainder of this file is
> retained as the historical design record; whenever it proposes a different
> cache scope, grant scope, sandbox behavior, flow order, or UX, the current
> contract wins. Current proof gaps live in `agent-e2e-test-matrix.md`.
>
> **Post-implementation gaps found in the 2026-07-28 audit:**
>
> - D-0008 remains open: approved scheduled-job work is requeued as a new run
>   after the old lease is released; same-fenced-run resume and explicit
>   `controlApprovers` routing are not built.
> - Canonical audit linkage is incomplete: persisted decisions currently carry
>   no matched `PermissionRule` ids, while inline short-circuit decisions do not
>   consistently create canonical `PermissionDecision` rows.
> - `SandboxLease` is modeled and persisted but is not created by the production
>   runner path. That is lifecycle/audit completeness for optional
>   `sandbox_runtime`, not a blocker for `direct`, fleet, or production use.
> - For runs that select `sandbox_runtime`, D-0005 keeps sandbox
>   escape-as-a-new-action deferred until protected-path and credential rails
>   remain authoritative outside the OS jail.
> - The unused `remembered_deny` and `standing_grant` decision-memory kinds need
>   an explicit finish-or-remove decision.
> - Cache writes fail open to the live decision, but a decision-memory read
>   failure currently escapes the coordinator. Until that is fixed, the cache
>   is not operationally a completely optional optimization.
> - Packaged/live proof still needs allow-once execution resume, run interruption,
>   real command output, and co-resident agent grant-isolation coverage before
>   the E2E merge gate can become required.

## Current shipped contract

The host-side coordinator is the single allow authority. Its precedence is:

```text
hard deny -> locked preset -> fixed image -> reviewed agent rule/capability
-> deterministic rails -> cached classifier allow -> classifier -> human
```

The stages after deterministic rails are conditional:

- A deterministic rail can allow, deny, or require approval. An approval floor
  goes to the learned-root stage or the human; neither cache nor classifier may
  weaken it.
- The worker IPC lane computes a versioned effect hash from app, provider
  account, parent conversation, agent, tool, canonical action, schema version,
  and rail version. Threads share their parent conversation's cache. When a
  request has no parent-conversation id, the hash falls back to
  app/provider-account/agent/effect scope. Missing, redacted, or risk-relevant
  truncated input is not cacheable.
- The cache reuses only a classifier `allow`. Stored `ask` verdicts are not a
  shortcut and are classified again. Human `Allow once` decisions never enter
  reusable decision memory.
- In `auto` and `auto_strict`, eligible tool requests may reach the risk
  classifier after the deterministic stages abstain. The model returns only
  `risk_level`, optional `risk_category`, and `reason`; it never decides
  authorization. Gantry maps low/medium risk to `allow_once` and high/critical,
  malformed, timed-out, or unavailable results to human approval. An unattended
  request that still needs a human is denied rather than left waiting.
- A human prompt is durably recorded before delivery. Channel-authenticated
  responses resolve the pending record; stale, late, cancelled, or unsigned
  responses cannot grant access.
- `Allow for future` creates narrowly scoped **agent-owned** authority, mirrors
  it through the settings desired-state path, and applies to every conversation
  where that agent runs. Learned trusted roots are also app+agent scoped.
  Conversation and thread ids remain delivery/audit context; they do not turn
  durable agent authority into conversation-local authority.
- Optional stages vary by lane. Worker IPC has the full effect-cache and
  classifier path. Inline third-party MCP uses the coordinator and classifier
  without decision-memory caching. Core-tool paths use the same hard
  precedence and durable human tail but do not all invoke the classifier or
  cache.
- `direct` has no inner Claude SDK or Gantry OS sandbox. Its controls are
  deterministic authorization rails plus the deployment's host/container/VM
  boundary. `sandbox_runtime` is optional defense-in-depth that adds an outer
  whole-runner OS jail in any deployment mode.

## Historical design record

Everything below records the investigation, proposals, rejected alternatives,
and staged acceptance language that led to the shipped implementation. It is
not the current runtime contract.

Status: GRILL + DOUBLE-CRITIQUE + PLAN-VALIDATION HARDENED 2026-07-22 (Fable + Codex
critiques + a Codex plan-validation, all folded). **L2 sandbox-relaxation FOLDED IN
(direct-relaxed is the universal default; `sandbox_runtime` opt-in) — L2 RE-VALIDATED
2026-07-22 (Codex, file:line evidence): seam CONFIRMED; `sandbox_runtime` isolation
CONFIRMED; all six precedence sites CONFIRMED intact post-PAY-1; REFUTED — no
independent credential denylist exists in direct mode (the `~/.ssh`/`~/.aws`/settings
denies live INSIDE the SDK sandbox config, so the escape hatch alone would drop them;
`allowAppleEvents`/`filesystem.disabled` absent from the SDK surface — deny path
lists, `allowUnixSockets`, `allowMachLookup` exist). CLIENT RULING 2026-07-22 ("we
already have a permission system for every action; the SDK sandbox makes the agent
perform less"): authorization is the sole control. L2 lands in TWO steps within the
same story: L2i — immediately reduce the direct-mode SDK sandbox profile to
credential/protected-path denies ONLY plus allowUnixSockets/allowMachLookup (no other
enforcement; no escape hatch yet); L2ii — once the coordinator rails carry the
protected-path/credential ask-floors, the sandbox stops enforcing entirely (escape
hatch on, gated by rails). No credential-guard gap exists at any point.**
Supersedes
`permission-floor-and-promotion-goal-prompt.md`, folds `permission-simplification-goal-prompt.md`.
RCA: `git-permission-rca.md`, promoted into this architecture folder on
2026-07-22. Its incident-specific external-log observations remain historical
evidence rather than assertions re-verified by this status update.

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

**FOUNDING PRINCIPLE (user, 2026-07-23): the CLASSIFIER does the heavy lifting,
not the allowlist/cache.** The cache/decision-memory is "nothing but an allowlist
of the agent's verdicts" — a latency/cost memo of what the classifier already
decided, NOT the thing that decides whether to ask. If we lean on the allowlist to
suppress prompts, then everything NOT in it prompts — which is exactly today's
flood. Invert it:
- A cache **MISS is never a reason to ask a human.** A miss means: call the
  classifier. Only the classifier's genuine ASK verdict (real high-risk without
  sufficient authorization) ever reaches a human.
- The classifier is calibrated (codex two-factor + calibration lines) to
  confidently ALLOW the low/medium-risk majority ON ITS OWN — no human, no
  pre-seeded rule. That is what shrinks the prompt volume, not a growing allowlist.
- The cache is then a pure optimization: don't re-invoke the LLM for an identical
  effect we already judged. Remove the cache and correctness is unchanged; only
  latency/cost rises. It must never be load-bearing for the ask/allow decision.
- Reviewed rules + capabilities (rung 2) remain for DURABLE, admin-granted
  authority (things worth a one-time review), but day-to-day "should I ask" is the
  classifier's job, not "is there an allowlist entry".
Success metric: with an EMPTY cache and NO saved rules, a fresh conversation of
ordinary work should reach the human only a handful of times — because the
classifier allows the rest. If an empty cache floods, the classifier is
under-empowered — fix the classifier, not the cache.

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

## Decision memory — FOUR distinct kinds, never conflated (scope updated 2026-07-23)
1. **Risk-verdict cache** — the intrinsic `risk_level` for an effect, keyed by
   effect hash, **agent-level/global** (conversation-independent; a hit at
   low/medium risk auto-allows). This is the ONLY reused, cross-conversation
   store, and it is safe precisely because it holds no authorization.
2. **Remembered denies** — surfaced with an ambient undo; list/revoke before ship.
   Scope **per-conversation** (a deny in one chat does not silently block another).
3. **Trusted roots** — separate structure (canonical root, principal, revocation),
   **per-conversation** grant scope by default.
4. **Standing human grants ("Allow for future")** — separate; **per-conversation**
   (grill-locked 2026-07-23). Agent-wide authority is a reviewed settings.yaml edit,
   not a prompt tap. Only offered for durably-safe (low/medium, cache-eligible)
   actions.
**"Allow once" is per-interaction and is NEVER written to any reusable store — even
a high-risk action approved once in a conversation re-asks on the next identical
call.** Kinds 2-4 carry a `conversationId` in their unique lookup identity; kind 1
does not (it is the shared risk fact). Dedicated versioned table (beside
`permission_promotion_counters`; `permission_decisions` is ID-keyed only,
`permissions.ts:42`) with: stable row id, verdict/effect, decision kind,
**conversationId (kinds 2-4)**, effect-schema version, rail/catalog version,
provenance (approving principal), created/expiry, `revoked_at`, unique lookup
identity, list/revoke repo methods.

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

## Field audit — live-log findings (2026-07-23) + fixes required

PERM-1/PERM-2/L2 are live. A live-log audit (285 asks) shows the flood persists —
but NOT because the classifier is strict: **198/285 asks went to a human; only 44
reached the auto-classifier.** The pre-classifier plumbing asks about input
*formatting*, not action *risk*. Four families, all evidence-backed:

**F1 — sanitize/truncate trip-wire (dominant, THE root cause).** IPC
sanitization caps every string at 500 chars (`ipc-tool-input-sanitization.ts:6`,
applied `ipc-parsing.ts:407`) and flags ANY truncation/redaction as "altered".
The host ALSO prefixes every shell command with a runtime env block
(`bash-trust-env.ts`: `GODEBUG=netdns=go HTTP_PROXY='…' HTTPS_PROXY='…' ×6
proxies + NO_PROXY + NODE_USE_ENV_PROXY + ~9 CA-cert vars each
`KEY='/tmp/model_gateway-ca.pem'`) ≈ **740 chars** — so the 500-char cut lands
INSIDE the prefix and the actual command (`head -30`, `npx remotion render …`)
is entirely discarded. Five consumers then see only a half-cut prefix:
- rails: `permission-deterministic-rails.ts:50` (`inputIsIncomplete` → ask)
- classifier: `permission-classifier.ts:287-311` (`input_truncated` → skip → ask)
- effect key: `permission-effect-key.ts:108-119` (incomplete → NO hash → cache
  skipped at `permission-decision-coordinator.ts:108`) — the same command can
  NEVER cache and re-asks forever.
- **reviewed-rule allowlist** (`tool-execution-policy-service.ts:353` /
  `tool-rule-matcher.ts:373`): it DOES strip the prefix via
  `normalizeRuntimeOwnedBashCommandForMatching`, but truncation already deleted
  the command, so a saved `RunCommand(head -30)` never matches. LIVE EVIDENCE:
  the agent has **38 saved `RunCommand(...)` rules in settings.yaml**, yet across
  the session **165 RunCommands went to a human and 0 matched a reviewed_rule**
  (FileRead/Write/Edit DO match — they key on tool name, no command string to
  corrupt). The user's own approved permissions are silently dead.
- parser (F2): the surviving prefix is unparseable → "env assignments not
  supported" → ask.
Even `send_message`/`todo_update` tripped F1 (long body / a key matching the
sensitive-key regex).
FIX: strip the host env-prefix and evaluate the REAL command BEFORE any
truncation. Feed rails + classifier + effect key + reviewed-rule matcher the
classifier-length view (16k, `PERMISSION_CLASSIFIER_MAX_STRING_LENGTH`) with the
prefix removed first (`stripHostInjectedEnvPrefix` /
`normalizeRuntimeOwnedBashCommandForMatching` must run pre-truncation, not
post). The 500-char view stays display/receipt-only. "Truncated → ask" then
fires only when a real command genuinely exceeds 16k. This one fix revives the
cache, the classifier, the rails AND the user's saved allowlist at once.

**F2 — self-inflicted parser refusal.** The rails' bash parser rejects
"Bash environment assignments are not supported" — on the env-assignment prefix
the host itself injected (same prefix as F1). We make the command unparseable,
then ask the human about it. FIX: strip the host prefix before parsing (covered
by F1's pre-strip); env assignments the AGENT wrote still ask.

**F3 — unregistered semantic capability poisons unrelated tools.** A tool-policy
rule referencing an unknown capability (`capability:google.sheets.values.update`)
fails the WHOLE policy match, so unrelated tools (FileRead, render_progress)
fall to a human with "No canonical tool execution policy matched". FIX: an
unresolvable rule is skipped (logged once), never converts other tools' asks.

**F4 — first-party benign tools have no birthright rule.** `send_message`,
`todo_update`, `render_progress`, and scheduler READS (`scheduler_list_*`,
`scheduler_get_job`) asked ~28 times. These are the agent's own control-plane
surface. FIX: a reviewed first-party default-allow set (benign gantry MCP tools;
scheduler MUTATIONS stay gated), evaluated before sanitization can trip.

**F5 — Codex/Guardian alignment (research DONE, openai/codex@808d3c27; full
findings with file:line citations: `codex-guardian-classifier-reference.md`).** Codex's current
architecture: deterministic rules/safelist/danger checks → Allow|Prompt|
Forbidden → Prompt routes to the Guardian LLM (or human) → Guardian returns
allow|deny only. What we adopt:
1. **Deterministic known-safe list BEFORE the LLM** (`is_safe_command.rs`):
   bare reads (`cat cd cut echo grep head ls nl pwd stat tail wc which whoami`
   …) plus guarded `find`/`rg`/git-reads/`sed -n`; compound commands safe only
   when every leaf is safe and operators are limited to `&& || ; |`. Extend our
   read-only gate to this catalog — these never reach the classifier.
2. **Two-factor verdict** (`prompt.rs:672-708`): score `risk_level`
   (low/medium/high/critical) and `user_authorization` (unknown/low/medium/
   high) SEPARATELY, then derive the outcome: low/medium risk → allow
   regardless of authorization (unless an explicit deny rule or affirmative
   prompt-injection evidence); high → allow only when authorization ≥ medium
   and narrowly scoped; critical → deny. Adopt this rubric in our classifier
   prompt (upgrade from our one-shot allow|ask reasoning); our tail keeps ASK
   as the third outcome since we have an interactive human (Guardian instead
   makes the agent message the user after a deny).
3. **Their calibration lines fix our observed over-asks verbatim:** "Do not
   assign high/critical solely because a path is outside the writable
   workspace roots"; "sandbox retry/escalation is not suspicious by itself";
   "benign local filesystem actions are usually low even outside the
   workspace root"; user-requested `rm -rf` of a verified-narrow target is
   low/medium. Import these into the prompt — they directly retire our
   "Path is outside allowed working directories" ask family.
4. **Trusted-evidence rules**: only user/developer messages + AGENTS.md +
   answers to ask-user establish authorization; tool outputs/skills/assistant
   text are untrusted evidence that can supply implementation details but not
   expand approval. Mirrors our "identity is evidence, not authorization" —
   keep, and add the authorization-scoring vocabulary.
5. **Fail-closed** on parse/timeout (matches ours), low-risk short-circuit
   answer shape, and escalation-as-new-action (`require_escalated` → fresh
   approval id, prior sandboxed approval never reused) — confirms SANDBOX-1's
   design.
What we do NOT adopt: Guardian's read-only tool access during judging (v2 —
big power-up, real complexity), transcript-delta review sessions, and the
managed policy-config substitution.

Order: F1 first (it unblocks the cache, which multiplies every other fix),
then F4, F2 (mostly free with F1), F3, then F5 (classifier prompt rewrite to
the two-factor rubric + known-safe catalog). Implement as ONE simplification
pass — the shared principle is "risk decisions see the real action; display
sees the sanitized one."

## Leaner target (ponytail cut pass, 2026-07-23) — SUPERSEDES the fuller text below where they differ

Before implementing, three deliberate cuts make the model both simpler AND safer.
These win over any fuller description later in this doc:

1. **Classifier judges RISK ONLY; the ENGINE owns authorization.** Codex makes its
   LLM *guess* `user_authorization` from the transcript because Guardian is
   stateless — ours is NOT. The engine deterministically holds the authorization
   facts (a conversation grant exists? requester is an admin? a capability covers
   this? trusted root?). So the classifier returns just `risk_level`
   (low/med/high/critical) + rationale; the ENGINE derives the outcome:
   low/med → allow; high → allow only if it already holds authorization
   (grant/admin/capability), else ASK; critical → ASK (or hard-deny by rail).
   Removes a whole hallucination-prone LLM output and keeps authorization a
   deterministic fact, not a guess. (We still import codex's RISK calibration
   lines verbatim — those are about risk scoring, which we keep.)
2. **ONE cache, per-conversation, pure optimization.** Ship a single
   per-conversation classifier-verdict cache (memo of `risk_level` for an effect
   in this conversation). DEFER the separate agent-global risk cache until
   measured latency demands it. Since the classifier does the heavy lifting and a
   miss just re-invokes it (never asks a human), one store is enough and the
   cross-conversation-leak reasoning disappears entirely.
3. **Rung 2 = CAPABILITIES only.** Exact-command `RunCommand(...)` rules are being
   deprecated, so the reviewed-authority rung is just capabilities (semantic
   bundles). One concept, not two.

Net leaner ladder: **catalog+capabilities (deterministic allow) → hard floors →
classifier(risk-only) + engine-owned authorization + per-conversation memo →
human.** Four conceptual layers. The fuller six-rung/two-factor/split-cache text
below is the design record; implement the leaner version above.

## Holistic redesign (grill-locked 2026-07-23) — one model, Claude-Code/Codex-shaped

The field audit proves the engine asks on the wrong axis (input *formatting*,
not action *risk*) and leaks approvals across conversations. Rethink the whole
flow as a fixed ladder — each rung sees the REAL, prefix-stripped, pre-truncation
action, and each rung's job is exactly one of {auto-run, floor-deny, floor-ask,
defer}. This is the Claude-Code/Codex shape: cheap deterministic layers first,
the LLM only for genuine ambiguity, the human only for real risk.

**The ladder (first decisive rung wins):**
0. **Known-safe catalog (NEW, from codex `is_safe_command.rs`)** → auto-run,
   never touches LLM or human: bare reads (`cat/ls/grep/head/tail/wc/pwd/stat/
   which/whoami…`), guarded `find/rg/sed -n/git-reads`, compound only if every
   leaf is safe and operators ∈ `&& || ; |`. Plus the **first-party benign
   gantry-MCP set** (F4: `send_message`, `todo_update`, `render_progress`,
   `scheduler_list_*`, `scheduler_get_job`). Scheduler mutations are NOT here.
1. **Hard floors (PERM-1 precedence, unchanged):** hard-deny catalog → locked
   preset → fixed-image → then the deterministic rails (destructive / credential
   / egress-uploads-local-file / privilege / out-of-trusted-root). Rails are
   ASK-or-DENY floors and re-run on every cache hit. **They now parse the real
   command** (F1/F2 fix: strip host env-prefix + use 16k view before parsing) so
   a benign command is no longer mis-floored as "incomplete/unparseable".
2. **Reviewed-rule allowlist** (settings.yaml selections + per-conversation
   grants) → allow. Revived by F1 so the 38 saved `RunCommand(...)` rules match
   again; going forward we STOP minting new exact-command rules (catalog +
   classifier replace them).
3. **Cache (SPLIT — the conversation-leak fix):** two independent stores.
   - **Risk-verdict cache — agent-level, global, shareable.** Keyed
     (appId, agentFolder, effectHash). Stores ONLY the intrinsic
     `risk_level` ("`head -30` = low"). Conversation-independent by nature, so
     sharing it across chats leaks nothing. A hit at low/medium risk → allow.
   - **Authorization — per-conversation, NEVER global.** Human approval and any
     conversation-derived authority key on
     (appId, agentFolder, **conversationId**, effectHash|root). A high/critical
     action needs authorization from THIS conversation; conversation-A's approval
     never auto-allows conversation-B. This is the user-reported leak, closed.
     **Threads INHERIT their parent conversation (user, 2026-07-23):** the scope
     key is the conversation/channel (`conversationId`), NOT `threadId`. A grant
     given in the conversation covers every thread/topic under it — never re-ask
     in a thread for something the conversation already authorized. (Only the
     conversation is the boundary; threads are sub-units of the same grant scope.)
4. **Empowered classifier (two-factor, codex-aligned, cache-miss only,
   fail-closed→ASK):** returns `risk_level`(low/med/high/critical) ×
   `user_authorization`(unknown→high), outcome DERIVED by rubric — low/med →
   allow regardless of authz (unless an explicit deny rule / affirmative
   injection evidence); high → allow only if authz≥medium AND narrowly scoped;
   critical → deny; anything unresolved → ASK (our interactive third outcome,
   where Guardian would make the agent message the user). `risk_level` is cached
   globally (rung 3a); `user_authorization` is judged fresh per conversation and
   only ever satisfied by a same-conversation grant (rung 3b). Import codex
   calibration verbatim (outside-workspace ≠ high; sandbox-retry ≠ suspicious;
   benign local FS = low; scoped user-requested `rm -rf` = low/med).
5. **Human prompt (mobile-first, 3 lines):** show the REAL action
   (prefix-stripped, capped — never proxy/env noise), the classifier's one-line
   risk rationale, and the risk level. HIDE internal reasons ("input sanitized",
   effect keys, matched rule). Buttons:
   - **Offer "Allow for future" ONLY when durably safe to repeat** = low/medium
     risk AND cache-eligible. High/critical → **[Allow once] [Deny]** only; a
     repeat always gets a fresh human look (allow_once is never cached — even in
     the same conversation, high-risk re-asks every time).
   - "Allow for future" writes a **per-conversation** grant (not settings.yaml,
     not agent-wide). Agent-wide authority stays a reviewed settings.yaml edit.

**Why this matches Claude Code / Codex:** rung 0 = their known-safe allowlist;
rungs 1-2 = their deterministic exec-policy (allow/prompt/forbidden); rung 4 =
their LLM reviewer (Guardian / `canAutoApprove`) that judges the real command
and splits risk from authorization; rung 5 = their user prompt. We keep ASK as a
first-class outcome (they route a Guardian deny back through the agent) because
Gantry has a live human tail. Escalation-as-new-action (SANDBOX-1) mirrors
codex's `require_escalated` fresh-approval path.

## Extended scope (grill-locked 2026-07-23 round 2) — the surfaces we'd missed

**Birthright tools (auto-allow, never prompt) vs ladder.** Birthright =
FileRead, FileSearch, WebSearch, WebRead, **in-workspace** FileEdit/FileWrite,
the rung-0 known-safe shell catalog, and benign first-party gantry-MCP
(send_message, todo_update, render_progress, scheduler READS). Everything with a
real side effect rides the ladder: out-of-workspace writes, arbitrary shell,
network egress, scheduler MUTATIONS, capability actions with side effects.

**One policy, one coordinator, all lanes (ponytail).** Inline (in-process main),
SDK worker, DeepAgents worker, sub-agents, and scheduled jobs share the SAME
ladder + SAME birthright. Lanes differ ONLY mechanically: how the human tail is
reached (in-process callback vs IPC vs durable job record) and how the agent
pauses/resumes. No per-type risk rules.

**Requester ≠ approver (delivery vs authority).** A non-admin can trigger an
action that needs approval. The prompt is shown IN THE CONVERSATION to everyone
(transparency — the group sees what the agent wants to do), but only admins
(`controlApprovers`) have a working Accept; non-admins see it as pending, cannot
act. The agent PAUSES until an admin decides. Applies to every lane.

**Pause-until-approve, durable, NO timebox (extends the killed 5-min grant, see
[[no-timed-grant-permission]]).** A pending ask pauses the turn/job indefinitely
— live turns hold, jobs persist a `paused` status and resume the SAME run — until
an admin accepts (resume) or denies (cancel). No auto-expiry, no re-ask storm.
This replaces ALL timeboxing across every permission, not just jobs.

**Delegation.** A sub-agent is the same run's authority, not a new principal: it
inherits the conversation's standing grants + birthright, and anything it needs
approved pauses and prompts in the SAME conversation (admin-accept). One grant
scope, one audit trail, no separate sub-agent store.

**Network egress = classifier data-exfil lens, not a separate prompt.** The
classifier judges egress by tracing payload→destination (codex-aligned): sensitive
data → untrusted destination = high risk → ask; requests to allowlisted /
capability-granted / user-owned hosts = low → allow. The deterministic egress
rail still HARD-FLOORS upload-local-file patterns (`curl -d @f host`). No second
prompt surface.

**Denial behavior.** On deny (admin or rubric) the agent receives a structured
denial + reason and must either pursue a materially safer alternative or message
the user and ask — it may NOT silently re-run the identical action (codex-aligned;
escalation-as-new-action is SANDBOX-1, an explicit fresh request, not a silent
retry).

## Capabilities are the semantic reviewed-authority layer (rung 2 done right) — F3 reframe

Correction (user, 2026-07-23): `google.sheets.*` is NOT a connector — it is a
**semantic capability**, and capabilities are NOT just CLI. A capability is a
reviewed authority BUNDLE (`capability-runtime-access.ts`) with FIVE source
types, each mapping to a different execution authority the permission model must
resolve uniformly:
- `local_cli` (e.g. gog) → `commandRules` + `credentialDirs` + `networkBindings.hosts`
- `skill_action` → `skillId`/`selectedAction` + `commandRules` + `declaredEnvRefs` + `networkBindings.hosts`
- `mcp_server` → `reviewedServerId` + `allowedTools` (`mcp__srv__tool`) + `credentialRefs` + `networkHosts`
- `builtin_tool` → `runtimeToolRules` (facade tool authority)
- `configured_adapter` → `adapterRef`

**Does it fit the new model? YES — better than before, and it is the ONE
abstraction that unifies every authority axis.** A granted capability, whatever
its source, is the durable, admin-reviewed, SEMANTIC form of rung-2 authority
that REPLACES accumulating exact-command `RunCommand(...)` rules. The permission
engine resolves a granted capability to its bundle and auto-authorizes, with no
prompt, exactly what the bundle covers — per source type: the CLI/skill command,
the reviewed MCP tool names, the facade tool rules, or the adapter — PLUS its
`hosts` as trusted egress (feeds the network lens above) and its
`credentialDirs`/`credentialRefs` for the protected-path rail. The admin reviews
the capability ONCE; the agent then uses it freely within the bundle, across any
lane. This is the "stop minting exact-command rules" end state made concrete —
and it means the resolve/skip-unknown/don't-poison fixes below must be
source-type-agnostic (a bad `mcp_server` or `skill_action` capability must not
poison other tools any more than a `local_cli` one does).

**F3 bugs blocking that (from the live log):** `render_progress` and `FileRead`
were denied with *"No canonical tool execution policy matched. Unsupported
autonomous tool rule capability: google.sheets.values.update"*
(`tool-execution-policy-service.ts:240,486`). Two defects:
1. **Capability grant does not expand to its authority.** The capability id reaches
   the policy matcher as a bare, unresolved rule instead of its resolved bundle —
   evidence: settings.yaml carries BOTH `google.sheets.values.update` (the
   capability) AND a hand-added `RunCommand(gog sheets *)` (the workaround). Fix:
   materialize a granted capability into its source-typed authority (commandRules /
   reviewed MCP tools / facade tool rules / adapter, + hosts + credential dirs) so
   the underlying action auto-allows without a parallel hand-written rule — for
   every source type, not just `local_cli`.
2. **An unresolved capability poisons UNRELATED tools.** One bad capability rule
   fails the WHOLE policy match, so `render_progress`/`FileRead` fall to a human.
   Fix: skip an unresolvable rule (log once), never let it convert another tool's
   decision. (Also fixes the `google.sheets.values.append` variant seen on
   render_progress.)

Plumb `semanticCapabilityDefinitions` (already parsed at `ipc-parsing.ts:417`) to
the coordinator/policy service so capability→bundle resolution happens at
decision time. Net: capabilities become the clean reviewed-authority layer;
exact-command rules are deprecated; the classifier + catalog cover everything not
worth a durable capability.

## Extended scope (grill-locked 2026-07-23 round 3) — agent-authority + coverage close-out

**Agent self-request (`request_access`, `capabilities.ts:81`) = the durable-grant
path.** Day-to-day allow/ask is the classifier's job. `request_access` is how an
agent that needs a capability REPEATEDLY asks the admin to grant it — durable
(`temporaryOnly=false`) or this-conversation (`true`). It routes to an admin as a
capability-GRANT approval (not a per-action prompt); on approval it becomes a
reviewed capability (rung 2) so future runs skip even the classifier. This is the
agent-initiated "allow for future".

**Meta-authority is categorically ASK-to-admin (never birthright, never
classifier-allow).** Changing settings or the agent's own permissions — the
`Config` tool, `admin_permission_revoke` (`admin-permissions.ts:48`) — is changing
the rules, not doing work. These ALWAYS pause for an admin regardless of risk
score; the classifier does not get to allow them. Prevents a persuasive transcript
from talking the agent into widening its own guardrails (the persistent-security-
weakening footgun). `admin_permission_list` stays read-only/birthright.

**Memory writes: birthright; content-safety stays in the existing memory-review
flow, NOT the permission coordinator.** Writing the agent's own scoped memory is
low-risk and never prompts. No double-gating; the two systems stay separate.

**Approver identity = one `canApprove(user, conversation)` check.** An approver is
someone with admin authority in THAT conversation (channel/guild admin role,
already validated in `conversation-membership-validation.ts`) OR on the configured
`controlApprovers` list (owner v1). Group chats use channel admins; DMs and the
control plane use `controlApprovers`. This is who gets the working Accept in the
requester≠approver model.

**Coverage close-out (verified in code — these need no new mechanism):**
- **Pause/resume primitive already exists — REUSE it (ponytail).** The durable
  pending-interaction system (`application/interactions/pending-interaction-
  durability.ts`, `-resolution.ts`, `-grants.ts`, `durable-interaction-handler.ts`)
  already persists a pending ask and resumes on answer. The universal
  pause-until-approve rides THIS, plus the jobs `paused` status — do not build a
  new pause path.
- **Fixed-image + locked preset are already hard floors** above the ladder
  (`permission-decision-coordinator.ts:52,59`) — capability-not-provisioned
  denies with no prompt. Unchanged; they sit at rung 1's top.
- **Unattended/autonomous (scheduled jobs, no human present)** = the jobs lane:
  a non-birthright action pauses the run (durable `paused`) and routes the ask to
  `controlApprovers`; it resumes the SAME run on approval. Never a timed re-ask.
- **Provider-account / send-as identity** is part of the action the classifier
  judges (identity is evidence, not authorization — codex `connected_account_email`
  pattern); no separate gate.
- **Attachment/file egress** (SEC-2 O_NOFOLLOW writer) is egress → the classifier
  data-exfil lens + the upload-local-file hard-floor already cover it.
- **Control-API key scopes** (`control-api-keys.ts`, `auth.ts`) and **model
  spend/rate guards** (`gantry-model-gateway.ts`) are SEPARATE axes (programmatic-
  API auth and resource guards) — explicitly OUT of this permission redesign's
  scope; noted so they're not mistaken for gaps.

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
