# Media render capability + environment-facts guidance — goal prompt

Status: **V4 SHAPE LOCKED (user, 2026-07-20): FACADE-PREFLIGHT v1.** Three
validation rounds all failed on Stage 3's capability/inventory/admission
machinery — so v1 CUTS it entirely. Ships: setup provisioner (browser + ffmpeg +
warm template) + the `media-render` facade + the skill (durably selected for new
agents via the existing reviewed-skill path) + env-facts honesty. The facade
PREFLIGHTS the toolchain itself at invocation and fails honestly; doctor and
env-facts consult the same small inspector. CUT from v1: semantic-capability
registration, admission preflight, worker advertisement, durable capability
selection — return only if a second provisioned capability ever needs them
(YAGNI). Stages 1 (sandbox/env plumbing, HOME-rewrite guard), 2 (provisioner,
SAFE at round 2), 4 (skill via SkillService + desired-state), and 5 (env facts)
survive as staged below with Stage-3 references reduced to the facade's own
preflight. One focused validation round on the v4 delta before implementation;
implementation queues after the E2E gate lane.

Prior status: RESTAGED v3 (2026-07-20) after plan-validation rounds 1 and 2 — see
`media-render-plan-validation.md` (round 1) and
`media-render-plan-validation-round2.md` (round 2). Round 2 cleared 10 of 13
round-1 contradictions and marked Stage 2 SAFE; this v3 resolves the surviving
Stage-3 inventory design, gate-ownership, the HOME-rewrite regression, and the
Stage-1/4/5 sharpenings. Round-3 validation gate required before
implementation.

## Root cause (one sentence)

The agent sandbox is provisioned blind: capabilities are discovered by runtime
failure, not provisioned up front or declared absent — the Chrome/Mach failure
was merely the layer where in-sandbox improvisation became impossible.

## The observed failure chain (live incident, 2026-07-20)

1. Render outputs written to ephemeral temp dirs got wiped (no durable
   convention communicated).
2. `npm install` hit the host's root-owned `~/.npm` (no seeded, writable
   package cache).
3. Remotion's render-time download of Chrome Headless Shell died in the
   sandbox (proxy-unaware DNS → ENOTFOUND).
4. TRUE BLOCKER: Chrome could not launch — `bootstrap_check_in ...
   MachPortRendezvousServer: Permission denied (1100)` + crashpad/profile
   writes to denied paths.
5. Artifact-store writes rejected while workspace-path attachments worked
   (fixed on main: `3da53d9f6`, `e803e21fa`, `14d79783d`; loader dedup runs
   as a separate closeout lane).

## Empirical proof (2026-07-20, this machine: darwin-arm64)

A full Remotion 4.0.290 render (210/210 frames → 916 KB MP4) succeeded INSIDE
`@anthropic-ai/sandbox-runtime@0.0.52` (srt) with:

- Pinned `chrome-headless-shell` (Chrome for Testing 147.0.7727.57) — no
  render-time download.
- A wrapper script passed as `--browser-executable` appending
  `--single-process --no-sandbox`. Single-process Chrome never registers the
  MachPortRendezvousServer; srt exposes mach-lookup only (no mach-register
  key), so multi-process Chrome is impossible under srt by construction.
- `HOME`/`TMPDIR` inside the sandbox `allowWrite` root.
- srt network config: `allowLocalBinding: true` (DevTools websocket) AND
  `allowMachLookup` gaining `com.apple.SystemConfiguration.configd` (without
  it Chrome's net stack spins on `SCDynamicStoreCreate` and DevTools never
  comes up). Keys nest INSIDE `network` (flat keys silently ignored).
- CORRECTION vs v1: this is TWO deltas against the current tree, not one —
  gantry's warm template pins `allowLocalBinding` to literal `false`
  (`runner-sandbox-provider.ts:21-26`) with unit tests asserting it. Local
  binding must become an explicit, media-gated effective-sandbox input, not a
  global flip. The `configd` addition is a deliberate, recorded sandbox-policy
  expansion (not "benign by assertion").

This proof covers one machine, one Chrome version, srt mode only. It does NOT
by itself support a general out-of-box claim — see the platform matrix and
hard gates below.

## Locked decisions (user, 2026-07-20 — unchanged)

1. **Out-of-box capability** on supported platforms (matrix below).
2. **Carrier = semantic capability + skill**, availability declared never
   discovered-by-failure.
3. **Full pre-provision at setup** (~400 MB), first render fast and offline.
4. **Generalize via environment-facts guidance**.
5. **Lane runs now, parallel with ponytail** (user accepts merge risk).

## Scope refinements (v2/v3, from validation — defaults; overturn explicitly)

- **Deployment mode v1 = `workstation` ONLY.** Fleet worker distribution and
  lane-aware scheduling are a separate future design (deferred). No worker
  advertisement claims fleet availability.
- **Supported platform matrix v1**: `darwin-arm64` (proven) and `linux-x64`
  (CI-verifiable via existing CI commands, no workflow edit), each with its
  own pinned source URL/sha256/layout in the provisioning manifest. Everything
  else (incl. Windows — srt rejects it) = HONEST UNAVAILABLE: doctor and
  environment-facts state it; setup does not select the capability; admission
  never claims it. No silent selection on a platform the smoke can't verify.
- **Direct-mode scope**: Anthropic SDK lane only. Direct-mode DeepAgents
  fails closed on shell authority by design
  (`deepagents-shell-filesystem-guard.ts:102-140`) and stays honest-
  unavailable; both lanes work under `sandbox_runtime`. No new enforcing
  DeepAgents command lane in this goal.
- **Executable surface = one facade**: a Gantry-owned, hash-pinned
  `media-render` CLI facade with narrow subcommands (`render`, `encode`,
  `gif`, `slideshow`) is the ONLY user-facing binding. It resolves the pinned
  Remotion CLI, Chrome wrapper (flag-enforcing), and ffmpeg from the
  activated toolchain; its preflight calls the toolchain inspector. Chrome
  and ffmpeg are never direct user actions.
- **No 400 MB copies per render**: the toolchain (browser, ffmpeg, warm
  Remotion project with node_modules) is a read-only content-addressed
  activation under `ARTIFACTS_DIR/toolchains/<manifest-hash>`; renders copy
  only a small writable composition skeleton into the workspace and resolve
  pinned deps from the activated root (controlled symlink created by the
  facade). Runtime install/download remains forbidden.
- **npm only** — the repo has no pnpm path; the v1 "pnpm equivalent" cache
  claim is dropped.
- Durable outputs: `<workspace>/media/`, delivery via #234 workspace-direct
  path (≤25 MB). Artifact store untouched.

## Restaged implementation (5 stages; each leaves tree green)

### Stage 1 — GENERIC sandbox + env plumbing only (no media wiring)

Stage 1 adds mechanism, not policy. It must NOT hard-code `media.render`; the
capability-derived gating is projected in Stage 3 once the internal capability
contract exists.

- Add a GENERIC `allowLocalBinding` + nested-mach-lookup INPUT to
  `RunnerSandboxSpawnInput`, emitted by `buildSandboxRuntimeConfig`
  (`runner-sandbox-provider.ts:226-267`; warm template currently pins
  `allowLocalBinding: false` at `:21-26,160-178`). SCOPE: this governs the
  OUTER `sandbox_runtime` boundary ONLY. The direct Anthropic SDK sandbox
  ALREADY sets `allowLocalBinding: true` for every SDK run
  (`filesystem-sandbox.ts:68-91`) — do NOT restate "non-media runs keep it
  false" as a global truth; the claim and its test are outer-srt-only.
  `configd` mach lookup may be added globally (recorded as a deliberate
  read-only policy expansion) since it is benign for all Apple-networking
  binaries.
- Per-run TEMP hygiene is GLOBAL and already owned by
  `agent-spawn-temp-directories.ts:5-16` (creates `/tmp/gantry-srt-*`, returns
  nothing in direct mode; cleanup at `agent-spawn.ts:769-797`). Restage THAT
  seam — not `agent-spawn-helpers.ts` — for temp; keep its create/cleanup
  ownership.
- HOME + npm cache are MEDIA-GATED, not global (smaller blast radius):
  `<workspace>/.gantry/home` (HOME), `<workspace>/.cache/npm`
  (`npm_config_cache`) are applied ONLY on media runs. Persistent (not
  cleanup-owned) — distinguish from per-run temp. Forward through BOTH
  boundaries: `buildBaseRunnerEnv` (outer) AND the Anthropic `buildSdkEnv`
  (`runner/runtime-env.ts:206-244`, currently drops HOME/cache). No SDK
  package changes.
- **HOME-rewrite regression (round-2 catch, must-fix):** the runner resolves
  and approves the Claude executable using `process.env.HOME`
  (`runner/runtime-env.ts:246-285`, `runner/query-loop.ts:303-308`); this
  machine installs under `~/.local/share/claude/versions`. Rewriting HOME
  would push that outside the allowed root. Preserve a host-validated
  executable path / original approved host-home root INDEPENDENT of the
  agent-facing HOME. Regression test the `.local/share/claude/versions` +
  `.local/bin` approval case under HOME rewrite.
- Tests cover BOTH harnesses (Anthropic SDK, DeepAgents) and BOTH sandbox
  providers (direct, sandbox_runtime) — not only "direct SDK env receives the
  vars".

### Stage 2 — workstation provisioner + toolchain inspector

- NEW dedicated setup provisioner (the existing toolchain bake is fleet-only,
  npm-only, rejects system packages — reuse its conventions: normalized
  relative paths, sha256 manifest/content hashes, temp materialization,
  atomic activation, quarantine, idempotent manifest identity — NOT its
  executor; avoid Uint8Array whole-file buffering for the browser archive).
- Per-OS/arch manifest: exact Chrome + ffmpeg source URLs, versions, sha256,
  archive layout, executable paths, wrapper hash, Remotion lockfile hash,
  smoke contract. Activation under `ARTIFACTS_DIR/toolchains/<hash>`;
  provision-status record in Gantry-owned data, never the agent workspace.
- One-time 2-frame enforcing-srt smoke render, result recorded.
- Setup flow: new resumable `toolchains` step AFTER `group`, BEFORE `verify`
  (update `OnboardingStep` union, `FULL_SEQUENCE`, dispatcher, labels/recap,
  state persistence, setup + doctor tests). Setup completion blocks on
  supported platforms if provisioning fails.
- Doctor = idempotent INSPECTOR only: validates manifest/inventory, reports
  one repair action; never downloads, mutates desired state, or renders.
- No `media.render` selection yet in this stage.

### Stage 3 — capability, DEDICATED availability inspector, gated durable selection

- **Leave `readImageCapabilityInventory()` UNCHANGED.** Round-2 blocker: its
  contract carries a second semantic dimension (`undefined` = image inventory
  not declared → admission fail-OPEN skip; `[]`/list = exhaustive for every
  selected semantic capability). Flattening fixed-image + provisioned ids into
  one inventory either preserves the fail-open path or makes the list
  exhaustive and wrongly rejects non-image-owned capabilities. Do NOT build a
  "composite inventory".
- Instead add ONE dedicated, route-aware media availability inspector
  returning a small typed result: `{ available, reason, verifiedManifestId,
  applicableLane }`. It verifies platform/arch, manifest, file hashes, exec
  modes, warm-template marker, and smoke record; caches at setup/startup;
  invalidates on manifest/file-metadata change; never hashes 400 MB per spawn.
  Consulted EXPLICITLY (not via the image reader) by every integration site.
  Do NOT generalize a second all-capability inventory until a second
  provisioned capability with the same lifecycle exists (YAGNI).
- Integration sites — name ALL of them, including BOTH worker-advertisement
  writers (round-2 catch: there are four `readImageCapabilityInventory`
  importers, not three): spawn admission (`agent-spawn-admission.ts:156`),
  workstation job readiness (`job-readiness-service.ts:519-556` — its
  image-rebuild remediation is wrong for a repairable workstation toolchain;
  route media through the inspector, not the image array), initial worker
  registration (`worker-identity.ts:23-37`), the worker capability reconciler
  (`worker-capability-reconciler.ts:217-227` — else a later reconcile
  overwrites the media advertisement), doctor, prompt env facts.
- **Sealed capability shape (no "bypass"):** extend the reviewed
  local-CLI/runtime-access contract (`capability-runtime-access.ts:19-24`,
  `agent-tool-runtime-rules.ts:178-196`) with explicit READ-ONLY runtime-asset
  directories + the outer-sandbox local-binding signal. PRESERVE local-CLI
  validation (absolute path, version, executable hash, narrow command
  templates — `semantic-capabilities.ts:380-424`). Add the asset root to
  runner read paths / additional dirs and ALWAYS to deny-write. One
  Gantry-owned `media-render` facade binding is the only user-facing surface.
  No public SDK/Control DTO.
- **Deployment scope = workstation ONLY (v1).** Set/require
  `runtime.deploymentMode: workstation`; a setup-time activation under the
  control host's `ARTIFACTS_DIR` says NOTHING about fleet-worker availability.
  Fleet worker distribution + lane-aware scheduling is a SEPARATE future
  design — explicitly deferred; no advertisement claims fleet availability.
- **Gate ownership — the direct proof is OWNED HERE, before selection.**
  Selection/advertisement happens ONLY after the gate applicable to the
  configured run lane passes (not merely after the srt smoke). If the
  configured lane is direct Anthropic and that proof has not been recorded on
  this host, the capability is provisioned + available-under-srt but is NOT
  selected/advertised for the direct lane → honest unavailable in facts.
- Out-of-box selection is a PERSISTENT desired-state op via the revision-owned
  writer (see Stage 4's `writeDesiredRuntimeSettings` path): register the
  reviewed tool definition, attach its source, select `media.render` for the
  new agent, append revision, reconcile Postgres, sync `settings.yaml` — all
  together. (New agents start empty — `runtime-settings.ts:142-151`.)

### Stage 4 — provider-neutral selected skill (durable desired-state write)

- Install `media-render/SKILL.md` via `SkillService.installSkill`
  (`skill-service.ts:37-104`) — idempotent by materialization identity, writes
  the artifact, returns the AUTHORITATIVE generated `skill:<uuid>`. Both
  provider projections require selected durable ids
  (`selected-skill-projection.ts:36-104`; Anthropic
  `execution-adapter.ts:180-215`; DeepAgents `skill-projection.ts:22-60`).
  No new skill-source abstraction.
- **Selection is the revision-owned desired-state write, NOT a DB binding.** A
  direct `bindSkillToAgent` is insufficient — the latest settings revision
  replaces bindings from `agent.sources.skills`
  (`desired-state-capability-reconcile.ts:43-107`). Add the EXACT returned
  `skill:<uuid>` to the new agent's desired skill sources through
  `writeDesiredRuntimeSettings` (`desired-settings-writer.ts:58-129`) so
  revision append + Postgres reconcile + `settings.yaml` sync happen together
  (same writer Stage 3 uses for the capability selection).
- Recipe invokes ONLY the facade; copies only the composition skeleton;
  writes/delivers from `<workspace>/media/`.

### Stage 5 — run-qualified environment facts + closeout

- Typed `EnvironmentFacts` input added to prompt compilation
  (`CompilePromptProfileOptions` → deterministic renderer inside the
  operating-guidance section, currently static
  `prompt-profile-service.ts:227-252,384-445`; threaded via
  `compileSpawnSystemPrompt`, `agent-spawn-prompt.ts:11-44`). Exactly two
  production call sites: worker spawn (`agent-spawn.ts:224-260`) and inline
  prep (`agent-spawn-host.ts:143-196`).
- **Two DISTINCT axes, not one "effective provider":** model the facts with
  SEPARATE fields for (a) execution provider/harness (Anthropic SDK vs
  DeepAgents) and (b) `RunnerSandboxProviderId` (direct vs sandbox_runtime).
  Availability + prose derive from BOTH plus the typed media-inspector result.
  "direct SDK vs outer srt" is not a provider.
- Compute facts PURELY, after model resolution/admission and before
  compilation — do NOT move credential/adapter side effects earlier to build
  prompt text. Inline agents get inline-lane facts; locked agents get
  physical/status-only facts without capability-request guidance.
  Provider-qualified prose ("media facade uses single-process Chrome under
  sandbox_runtime"), never blanket claims; unavailable states explicit.
  Preserve section budgets; test truncation/determinism.
- Focused tests + srt smoke. Stage 5 VALIDATES rendering/determinism and
  closes out — it is NOT where an already-advertised capability is first
  proven (that gate is owned in Stage 3).

## Hard gates (ownership assigned)

1. Scripted enforcing-srt smoke produces a playable MP4 — owned by Stage 2
   (provisioner records the smoke result).
2. **Direct-mode gate, owned by Stage 3, BEFORE selection/advertisement**: a
   real direct Anthropic-SDK agent renders a playable MP4 on this host before
   the direct/Anthropic lane advertises the capability. The tree passes no
   repo-owned mach-lookup list to the SDK sandbox, so the srt proof predicts
   nothing here — until recorded, the direct lane is honest-unavailable while
   srt stays available.
3. A `sandbox_runtime` DeepAgents render is its own Stage-3 gate if that lane
   is claimed; direct DeepAgents stays fail-closed (unchanged).

## Ponytail collision plan (validated against the live worktree)

- DO NOT touch ponytail Phase 4's contract files (`openapi-*schemas.ts`,
  `packages/contracts/src/jobs|settings`, `packages/sdk/*`). No new public
  DTO: media setup writes the EXISTING generic agent `sources`/`capabilities`
  settings shapes through `SettingsDesiredStateService`. If a public
  media/toolchain status DTO is ever wanted, defer until AR3 lands, then
  contracts-first through the new schema helper.
- KNOWN 4-file conflict with ponytail's committed Phase 1-3 work:
  `setup-flow-state.ts`, `setup-flow-final-steps.ts`,
  `setup-flow-simplified.test.ts`, `runtime-setup-doctor.e2e.test.ts`. User
  accepted this risk; keep the media diff in these files minimal and
  mechanical (one step insertion) to make the eventual ponytail merge cheap.
- **No `.github/workflows/ci.yml` edit.** linux-x64 verification runs inside
  the EXISTING CI commands (the provisioner + srt smoke execute under the
  current test invocation); the workflow file is unchanged. This deliberately
  avoids ponytail's uncommitted `ci.yml` change becoming a live collision.
- **If ponytail lands first, re-resolve — don't replay.** Ponytail's committed
  branch relocates desired-state/runtime-settings seams Stages 3-4 depend on
  (`desired-state-capability-reconcile.ts`, `desired-state-service.ts`,
  `desired-state-service-types.ts`, runtime-settings types). Rebase and
  re-resolve every Stage-3/4 import + line ref against post-ponytail main
  before closeout, rather than mechanically replaying current paths.

## Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Verified media facade, media-gated local binding, spawn env, admission path. |
| `settings.yaml` | Changed | New agents get attached skill/tool sources + durable `media.render` selection. |
| Postgres/runtime projection | Changed | Reviewed definitions + bindings match latest desired-state revision. |
| Control API | Unchanged by design | Generic settings/capability shapes suffice; no media DTO. |
| SDK/contracts | Unchanged by design | No new wire shape IF runtime-asset + sandbox-requirement stay inside Gantry-internal semantic/runtime-access contracts; avoid ponytail Phase 4 files. |
| CLI | Changed | Resumable setup `toolchains` step + doctor inspect/repair action. |
| Gantry MCP/admin skill | Read-only/observable | Existing catalog/settings tools expose the selection. |
| Anthropic execution adapter | Changed | `buildSdkEnv` forwards approved workspace HOME/tmp/npm-cache on media runs; channel delivery adapters remain unchanged. |
| Deployment mode | Workstation changed / fleet deferred | v1 = `runtime.deploymentMode: workstation`; fleet worker distribution + lane-aware scheduling is a separate future design. |
| Docs/prompts | Changed | Selected skill, environment facts, setup/doctor docs, platform matrix. |
| Audit/events | Changed | Provision/integrity/smoke/selection evidence as structured events. |
| Tests/verification | Changed | Provision+hash idempotence, composite inventory, admission, settings round trip, both skill projections, prompt facts, srt smoke, direct live gate. |
| Transient approval | Unchanged by design | Out-of-box = persistent new-agent selection, not allow-once. |
| Persistent capability selection | Changed | Select only after verified provision; keep settings/revision/Postgres in sync. |

## Non-goals

- No host-side render service; no CDP screencast.
- No mach-register relaxation, no seatbelt profile surgery, no global
  local-binding flip.
- No S3/artifact-store changes; no channel media APIs.
- No render-time downloads, ever.
- No enforcing direct-mode DeepAgents command lane.

## Validation history

- Round 1 (2026-07-20): NOT SAFE AS STAGED — 5 contract crossings, 13
  contradicted assumptions; `media-render-plan-validation.md`.
- Round 2 (2026-07-20): NOT APPROVED — Stage 2 SAFE, 10/13 resolved; surviving
  blockers = Stage-3 composite-inventory design (#4/#5), gate-ordering (#11),
  plus new Stage-1 HOME-rewrite regression and outer-srt-only local-binding
  scope; `media-render-plan-validation-round2.md`. This v3 resolves all eight
  minimum-restage items.
- Round 3: REQUIRED before implementation.
