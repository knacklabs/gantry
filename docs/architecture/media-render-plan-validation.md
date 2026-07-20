# Media-render goal-prompt plan validation

Date: 2026-07-20

Validated tree: `7cea800f4b88ee55d2704871693b721f914305bb` (`feature/media-render-capability`, equal to `main` at validation start)

Input: `docs/architecture/media-render-goal-prompt.md`

## Verdict

**NOT SAFE AS STAGED.** The empirical `sandbox_runtime` recipe is valuable, and
all of the named broad seams exist, but the implementation sketch crosses five
repo contracts incorrectly:

1. `sandbox_runtime` currently forces local binding off; adding only the
   `configd` Mach lookup cannot make the documented smoke render pass.
2. The existing toolchain bake is a fleet-only npm artifact pipeline, not a
   workstation setup provisioner for platform binaries and a 400 MB warm
   project.
3. Fixed-image inventory is optional and absent in the normal workstation path;
   it cannot honestly attest a setup-installed toolchain.
4. A bundled skill is not automatically selected, and the current bundled-skill
   source is Claude-specific while DeepAgents resolves only durable selected
   skill artifacts.
5. Operating guidance is static and is compiled before the effective worker
   sandbox/toolchain facts are assembled.

The plan is recoverable, but it needs a restaged design around one verified
media-toolchain inspector, one narrow Gantry-owned media command facade, durable
default selection for new agents, and provider-specific fact projection. Do not
declare or select `media.render` until the same inspector proves every pinned
piece and the applicable runtime smoke gate has passed.

## Stage verdicts

| Stage | Verdict | Concrete correction |
| --- | --- | --- |
| 1. Sandbox builder + spawn hygiene | **NEEDS-RESTAGE** | Make local binding an explicit, capability-gated sandbox input for media runs; add `configd` under `network.allowMachLookup`; create workspace-owned HOME/temp/cache paths for every spawn; and forward the approved env keys through the Claude SDK adapter. `agent-spawn-helpers.ts` alone is insufficient. |
| 2. Toolchain provisioning | **NEEDS-RESTAGE** | Add a workstation setup provisioner with an explicit OS/arch manifest, source URLs, hashes, atomic activation, resume state, and an srt smoke. Reuse content-addressed path/hash/integrity conventions, not the fleet npm bake executor as-is. Put the new setup step after `group` and before `verify`; make doctor inspect rather than provision or render. |
| 3. Capability + inventory | **NOT-SAFE** | Do not write a setup-installed capability into `GANTRY_IMAGE_CAPABILITIES_JSON`. Introduce a composite verified worker-capability inventory and route spawn admission, job readiness, worker advertisement, doctor, and prompt facts through it. Prefer one pinned Gantry media facade binding whose preflight verifies Remotion, Chrome, ffmpeg, wrapper, warm template, and smoke record. Register and durably select it for new agents through desired state. |
| 4. Bundled skill | **NEEDS-RESTAGE** | Package the recipe as `SKILL.md`, but also make it provider-neutral and selected. Claude can read the current bundled source; DeepAgents cannot. Either seed the bundled skill into the durable reviewed skill catalog/artifact store and select `skill:media-render`, or add a provider-neutral bundled-skill source used by both adapters. Do not copy 400 MB of `node_modules` per render. |
| 5. Environment-facts guidance | **NOT-SAFE** | Replace the static-block edit with a typed, generated environment-facts input. Compute it from the verified inventory plus the effective runner/SDK sandbox path, pass it through `compileSpawnSystemPrompt`, and render only facts valid for that run. Do not infer availability from a configured capability or process-global env. |

## 1. Named-seam validation

### Sandbox-runtime builder

The named seam exists, but the goal document understates the required change.

- `buildSandboxRuntimeConfig` is implemented in
  `apps/core/src/adapters/sandbox/runner-sandbox-provider.ts:226`. Mach lookup is
  correctly nested inside `network` at lines 233-244, matching the empirical
  schema finding.
- The current list contains only `com.apple.FSEvents`
  (`runner-sandbox-provider.ts:56,237-239`). Adding
  `com.apple.SystemConfiguration.configd` here is mechanically correct.
- The warm-template type fixes `allowLocalBinding` to the literal `false`
  (`runner-sandbox-provider.ts:21-26`), and the builder emits that value
  (`runner-sandbox-provider.ts:160-178,233-239`). Existing unit tests also pin
  `false` (`apps/core/test/unit/adapters/sandbox/runner-sandbox-provider.test.ts:134-137,193-194`).
- The empirical recipe explicitly requires `allowLocalBinding: true` for the
  DevTools websocket (`media-render-goal-prompt.md:43`). Stage 1 proposes only
  `configd` plus cache env (`media-render-goal-prompt.md:91-92`). Stage 2's smoke
  therefore cannot pass on the staged Stage 1 tree.
- Effective runner sandboxes are currently always constructed with
  `network: required` and `filesystem: workspace_write`
  (`apps/core/src/runtime/agent-spawn-helpers.ts:364-395`). The semantic
  capability's `sandboxProfile` is catalog metadata; it does not drive this
  effective profile.

Correction: do not turn local binding on globally by accident. Add an explicit
effective-sandbox requirement derived from selected `media.render`, carry it in
`RunnerSandboxSpawnInput`/the effective profile, and test media and non-media
runs separately. The `configd` addition may be global if that scope is accepted,
but calling a Mach-service allowance “benign read-only” is not proof; record it
as a deliberate sandbox-policy expansion.

### Spawn environment assembly

The outer spawn env seam exists, but the direct provider adds a second scrubbed
env boundary.

- `buildBaseRunnerEnv` assembles the runner process env in
  `apps/core/src/runtime/agent-spawn-helpers.ts:56-177`; `agent-spawn.ts:520-592`
  calls it per spawn.
- It overrides `TMPDIR`, `TMP`, and `TEMP` only when `runnerTempDir` exists
  (`agent-spawn-helpers.ts:108-115`).
- `createRunnerTempDirectories` returns no directory for `direct`; it creates a
  private temp directory only for `sandbox_runtime`
  (`apps/core/src/runtime/agent-spawn-temp-directories.ts:5-16`).
- Safe host-env projection includes temp keys but excludes `HOME` and package
  cache keys (`apps/core/src/runtime/agent-spawn-runtime-policy.ts:61-75`).
- The workspace itself is created with mode `0700` by
  `prepareRunnerWorkspace` (`agent-spawn-helpers.ts:228-244`). It is the correct
  ownership root for per-agent cache/home paths and durable `media/` output.

Correction: create explicit paths such as `<workspace>/.gantry/home`, a
per-spawn `<workspace>/.gantry/tmp/<run>`, and `<workspace>/.cache/npm`, and pass
them as `HOME`, `TMPDIR`/`TMP`/`TEMP`, and `npm_config_cache`. The repo uses npm
(`README.md:64`, `.github/workflows/ci.yml:42`) and has no pnpm setup path; the
goal's “pnpm equivalent” is speculative and should be removed unless a pinned
pnpm workflow is separately introduced and tested.

### Direct provider / Agent SDK sandbox

The direct seam confirms that per-spawn injection can be done **without changing
the external SDK package**, but it requires changes in Gantry's SDK adapter.

- `DirectRunnerSandboxProvider` is intentionally non-enforcing and spawns the
  runner with the supplied env
  (`apps/core/src/adapters/sandbox/runner-sandbox-provider.ts:71-105`). Direct
  Anthropic enforcement is inside the Agent SDK lane.
- `buildSdkFilesystemSandbox` sets `failIfUnavailable`, disables unsandboxed
  commands, enables local binding, and enables weaker Darwin network isolation
  (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/filesystem-sandbox.ts:68-91`).
- `query-loop.ts:285-294` uses that SDK sandbox only when the outer
  `sandbox_runtime` proxy is absent. The actual SDK query receives both
  `options.env` and `sandbox` at lines 368-395.
- `buildSdkEnv` forwards temp keys but not `HOME`, `npm_config_cache`, or a
  media-toolchain location
  (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/runtime-env.ts:206-243`).

Therefore `agent-spawn-helpers.ts` can seed the outer runner env, but
`runner/runtime-env.ts` must explicitly forward the safe media env keys into
`options.env`. No modification of `@anthropic-ai/claude-agent-sdk` is required.
The tree currently passes no repo-owned `allowMachLookup` list to the SDK
sandbox, so the goal's direct-mode hard gate remains necessary rather than
predicted proof.

There is also a scope contradiction: DeepAgents with shell/RunCommand authority
fails closed in direct mode. The guard accepts such authority only under
`sandbox_runtime`
(`apps/core/src/runtime/deepagents-shell-filesystem-guard.ts:102-140`). Thus
“new users' agents” cannot mean every selectable harness/provider today. The
goal must either:

1. scope direct-mode media rendering to `anthropic_sdk` and fail honestly for
   direct DeepAgents, while supporting both under `sandbox_runtime`; or
2. introduce a separately reviewed enforcing direct DeepAgents command lane,
   which is a larger security project and outside this goal.

The first option is the minimal correct scope.

### Semantic capability construction and runtime projection

The named capability model exists, but the suggested use of it is not faithful
to current behavior.

- `SemanticCapabilityDefinition` supports local-cli bindings, hashes, command
  templates, protected paths, network hosts, and catalog sandbox metadata
  (`apps/core/src/shared/semantic-capabilities.ts:17-70`).
- `buildLocalCliSemanticCapability` exists at lines 278-330, but emits exactly
  one local-cli binding and hardcodes
  `filesystem: credential_read` at line 325. Stage 3 claims it will define
  `workspace_write` (`media-render-goal-prompt.md:99-103`).
- Validation requires an absolute path, version, hash, and at least one allowed
  command template (`semantic-capabilities.ts:380-424`). These values validate
  catalog shape; this function does not hash the executable on the worker.
- Active tool-catalog bindings are the source of runtime authority
  (`apps/core/src/application/agents/agent-tool-runtime-rules.ts:80-151`).
  Local-cli definitions project command rules plus `protectedPaths` as
  `credentialDirs` (`agent-tool-runtime-rules.ts:178-196`). They do not project
  the semantic `sandboxProfile` into the effective runner sandbox.

Chrome is normally a child executable of Remotion, not the user-facing command,
and two Chrome/ffmpeg bindings omit the Remotion CLI and the flag-enforcing
wrapper. The safer and simpler shape is one Gantry-owned, hash-pinned
`media-render` facade with narrow subcommands (for example render, encode, gif,
slideshow). Its fixed implementation selects the pinned Remotion CLI, Chrome,
wrapper flags, and ffmpeg; its preflight calls the single toolchain inspector.
The toolchain root should be projected read-only. Using `protectedPaths` would
mechanically accomplish read-plus-deny-write today, but naming it a credential
directory is semantically wrong; prefer an explicit read-only runtime asset path
in the capability/runtime-access contract.

Finally, definition and installation are not authority. New settings agents are
created with empty sources and capabilities
(`apps/core/src/config/settings/runtime-settings.ts:142-151`). Full out-of-box
behavior requires the setup path to register the reviewed tool definition,
attach its source, durably select `media.render`, append the desired-state
revision, reconcile Postgres, and sync `settings.yaml`. This is a persistent
capability selection; transient approval behavior is unchanged.

### Fixed-image inventory and admission

This is the blocking contradiction in Stage 3.

- `worker-image-inventory.ts:1-6` explicitly defines an **immutable fixed-image**
  declaration via `GANTRY_IMAGE_CAPABILITIES_JSON`.
- `readImageCapabilityInventory` returns `undefined` when that env key is absent
  (`apps/core/src/shared/worker-image-inventory.ts:29-34`).
- Spawn admission treats `undefined` as “skip the check,” not “capability absent”
  (`apps/core/src/runtime/agent-spawn-admission.ts:155-169`).
- The error text tells the operator to rebuild/deploy a worker image
  (`worker-image-inventory.ts:52-60`), which is false remediation for a
  workstation setup artifact.
- The same image-only reader feeds job readiness, worker identity, and fleet
  reconciliation (`apps/core/src/jobs/execution-readiness.ts:63`,
  `apps/core/src/jobs/worker-identity.ts:35`, and
  `apps/core/src/jobs/worker-capability-reconciler.ts:58-68,219`).

Correction: retain fixed-image inventory for immutable image content and add a
separate verified provisioned-toolchain inventory. Merge them through one
worker-capability inspector used by all five consumers: live spawn admission,
job readiness, worker advertisement, doctor, and prompt environment facts. The
media entry exists only if platform/arch, manifest, all file hashes, executable
modes, warm-template marker, and required smoke result verify. Cache a full
verification at setup/startup and invalidate it on manifest/file metadata
change; do not hash 400 MB on every spawn.

### Toolchain artifact machinery and warm-template distribution

There is an existing bake/materialize path, but Stage 2 cannot reuse it as the
provisioner itself.

- `ToolchainArtifactStore` is explicitly a current-state npm toolchain bundle of
  `node_modules`, lockfile, and `package.json`, stored under
  `toolchains/<manifestHash>`
  (`apps/core/src/domain/ports/toolchain-artifact-store.ts:22-33`). Its
  materializer verifies sha256 and atomically activates or quarantines
  (`toolchain-artifact-store.ts:44-57`).
- Bundle normalization repeats the npm-only scope
  (`apps/core/src/adapters/artifacts/toolchains/toolchain-artifact-bundle.ts:6-12`)
  and defines the content-addressed storage ref at lines 99-110.
- The bake manifest accepts only npm specs and explicitly rejects system
  packages as requiring an image bake
  (`apps/core/src/jobs/toolchain-bake-manifest.ts:3-30`).
- The executor runs `npm install --ignore-scripts` and packs npm outputs
  (`apps/core/src/jobs/toolchain-bake-executor.ts:63-74`). It has no platform
  binary downloader, Chrome wrapper, or render smoke.
- The bake subsystem and capability reconciler are fleet-only; workstation mode
  is a no-op (`apps/core/src/jobs/toolchain-bake-bootstrap.ts:41-52,104-116`;
  `apps/core/src/jobs/worker-capability-reconciler.ts:58-68`).

This means platform download/provisioning is genuinely new. Reuse the safe
conventions—normalized relative paths, sha256 manifest/content hashes, temp
materialization, atomic activation, quarantine, and idempotent manifest
identity—but write a dedicated setup provisioner. The current artifact APIs
also hold every file as `Uint8Array`; blindly packing a roughly 400 MB browser
and project through that interface would be unnecessarily memory-heavy.

The correct Gantry-owned active location follows the existing runtime root:

`<GANTRY_HOME>/artifacts/toolchains/<sanitized-manifest-hash>/`

`ARTIFACTS_DIR` is `<runtime root>/artifacts`
(`apps/core/src/config/index.ts:231-234`), and the existing worker materializer
uses `<localRoot>/toolchains/<hash>`
(`apps/core/src/jobs/worker-capability-reconciler.ts:147-156`). Keep a small
current-manifest/provision status record under Gantry-owned data or inside the
activated manifest, never in the agent workspace. Project the activated root
read-only into the sandbox; workspace HOME/temp/cache/output remain writable.

The warm-template invocation also needs correction. Copying a project with its
entire `node_modules` for each render defeats the “first render is fast” goal.
Provision a read-only content-addressed template/toolchain; copy only the small
writable composition skeleton into the workspace and have the fixed facade
resolve the pinned Remotion CLI/dependencies from the activated toolchain (for
example via a controlled symlink created by the facade). All Remotion/Chrome
cache and profile writes must go to the per-spawn workspace paths. Runtime
install/download remains forbidden.

The setup manifest must specify, per supported OS/arch, the exact Chrome and
ffmpeg source, version, sha256, archive layout, executable paths, wrapper hash,
Remotion lockfile hash, and smoke contract. The goal currently has proof for one
machine and one Chrome version only; it does not define macOS architecture,
Linux, or unsupported-platform behavior. `sandbox_runtime` itself rejects
Windows (`runner-sandbox-provider.ts:118-121`). An out-of-box claim cannot be
made beyond the proven matrix.

### Setup and doctor staging

Setup has a clear insertion seam, but “setup doctor stage” conflates three
different responsibilities.

- `OnboardingStep` is a closed union in
  `apps/core/src/cli/onboarding-state.ts:8-21`.
- `FULL_SEQUENCE` orders `config -> group -> verify -> ready`
  (`apps/core/src/cli/setup-flow-state.ts:27-41`).
- `setup-flow.ts:86-145` is the central dispatcher, and its step labels are an
  exhaustive record at lines 254-308.
- `runVerifyStep` calls `runDoctorWithNetwork` and blocks/resumes on failures
  (`apps/core/src/cli/setup-flow-final-steps.ts:198-283`).
- `runDoctorWithNetwork` composes local doctor checks with async provider and
  storage checks (`apps/core/src/cli/doctor.ts:601-660`).

Add a resumable `toolchains` step after `group` and before `verify`. At that
point runtime home/config, Postgres, the agent, and its conversation binding all
exist, so the same step can provision, register, and durably select the
capability. `verify` can then observe the result. Update the union, sequence,
dispatcher, labels/recap, onboarding state persistence, setup tests, and doctor
tests.

Provisioning performs downloads, hash checks, activation, and the one-time
2-frame srt smoke. Doctor must be an idempotent inspector: validate the current
manifest/inventory and report one repair action; do not download, mutate desired
state, or run a render on every doctor invocation. Setup completion must block
on supported platforms if the locked out-of-box provision fails. Unsupported
platforms require an explicit product decision rather than silently selecting a
capability that admission cannot satisfy.

### Bundled skill distribution

The Claude bundled-skill seam exists, but it is neither auto-selected nor shared
with DeepAgents.

- `GANTRY_BUNDLED_SKILL_IDS` currently contains only `gantry-admin`, and
  `BundledGantrySkillSource` reads `.agents/skills/<id>/SKILL.md`
  (`apps/core/src/adapters/llm/anthropic-claude-agent/claude-skill-materializer.ts:39-68`).
- Claude combines that source with durable artifact skills, but passes the
  agent's selected ids as the enable filter
  (`apps/core/src/adapters/llm/anthropic-claude-agent/execution-adapter.ts:180-215`).
  An empty selection does not enable every bundled skill.
- DeepAgents has no bundled-package source. It returns no projection when no
  selected ids exist and resolves selected skills only from
  `SkillCatalogRepository` plus `SkillArtifactStore`
  (`apps/core/src/adapters/llm/deepagents-langchain/skill-projection.ts:22-37`).
- npm packaging ships only `.agents/skills/*/SKILL.md` (`package.json:30-37`),
  and package-hygiene tests assert that exact set
  (`apps/core/test/unit/repo/package-hygiene.test.ts:74-103`).

The recipe text fits the existing package shape; browser binaries, wrapper, and
warm project do not and belong in the provisioned toolchain. For provider
neutrality, seed the same reviewed `SKILL.md` as a durable catalog/artifact skill
and select it for the new agent, or refactor bundled sources into shared
application projection. The first option is smaller because DeepAgents already
has a reviewed selected-artifact path.

### Generated operating guidance

The named constant exists, but it has no dynamic input seam.

- `OPERATING_GUIDANCE_BLOCK` and its locked variant are static constants
  (`apps/core/src/application/agents/prompt-profile-service.ts:227-242`).
- `CompilePromptProfileOptions` has no inventory, workspace, or sandbox facts
  (`prompt-profile-service.ts:244-252`), and compilation selects only one of the
  two static blocks at lines 433-440.
- `compileSpawnSystemPrompt` passes group/persona/app/agent/access only
  (`apps/core/src/runtime/agent-spawn-prompt.ts:11-37`).
- Worker prompt compilation currently occurs before sandbox provider and spawn
  env assembly (`apps/core/src/runtime/agent-spawn.ts:224-231` versus the
  provider/env work beginning around lines 426 and 520). The inline path calls
  the same prompt helper (`apps/core/src/runtime/agent-spawn-host.ts:164-174`).

Correction: add a typed `EnvironmentFacts` value to prompt compilation and a
small deterministic renderer inside the operating-guidance section. Build the
facts before compilation from the same verified inventory inspector, workspace
root, effective provider (`direct` SDK versus outer `sandbox_runtime`), and
effective sandbox settings. Inline agents must receive facts valid for the
inline lane, not worker claims. Locked agents should receive safe physical facts
without capability-request guidance. Preserve section budgets and test
truncation/determinism.

Do not state “multi-process Chrome is impossible” for all runs. That conclusion
is proven for the tested srt shape, not yet for the SDK direct sandbox. Render
provider-qualified facts such as “media facade uses single-process Chrome under
sandbox_runtime” and declare unavailable states explicitly.

## 2. Corrected stage boundaries and gates

The following sequence preserves green stages and avoids declaring authority
before evidence exists:

1. **Sandbox and env prerequisites — NEEDS-RESTAGE**
   - Add media-gated local binding plus nested `configd` lookup to the outer
     sandbox contract.
   - Create workspace HOME/temp/npm-cache paths per spawn and forward them
     through the Claude SDK env boundary.
   - Tests: non-media local binding remains false; media srt config is true;
     direct SDK env receives only the approved workspace paths.
2. **Provisioner and inspector — NEEDS-RESTAGE**
   - Define the supported OS/arch pinned manifest and dedicated workstation
     provisioner under the artifact/toolchain adapter ownership.
   - Atomically install the facade, Chrome, ffmpeg, wrapper, and warm Remotion
     project under `ARTIFACTS_DIR/toolchains/<hash>`.
   - Run and record the 2-frame enforcing-srt smoke. Add the setup step and
     read-only doctor check, but do not yet select `media.render`.
3. **Capability, composite inventory, and durable selection — NOT-SAFE until corrected**
   - Add the facade-backed semantic definition and verified provisioned
     inventory source.
   - Update every current image-inventory consumer to use the composite
     inspector.
   - Register/attach/select only after verification; route through desired-state
     revision, runtime projection, and settings sync.
4. **Provider-neutral selected skill — NEEDS-RESTAGE**
   - Add `media-render/SKILL.md`, seed it into the reviewed durable skill path,
     and select it for the new agent.
   - Recipe invokes only the facade, copies only the small source skeleton, and
     writes/delivers from `<workspace>/media/`.
5. **Run-qualified facts and closeout — NOT-SAFE until corrected**
   - Thread typed verified facts into worker and inline prompt compilation.
   - Run focused tests plus the srt smoke.
   - Hard gate: a real direct Anthropic SDK agent renders and produces a playable
     MP4 before direct/Anthropic inventory advertises the capability. A
     `sandbox_runtime` DeepAgents run is a separate gate if that lane is claimed.

## 3. Ponytail Phase 4 collision analysis

The live Ponytail worktree (`feature/ponytail-audit`, `61a18b87d`) is at the end
of Phase 3 with uncommitted Phase 4 edits. At validation time its Phase 4 dirty
set was:

- `apps/core/src/control/server/openapi-contract-schemas.ts` (new)
- `apps/core/src/control/server/openapi-model-preview-schemas.ts`
- `apps/core/src/control/server/openapi-schemas.ts`
- `packages/contracts/src/jobs/index.ts`
- `packages/contracts/src/settings/index.ts`
- `packages/sdk/src/agents.ts`
- `packages/sdk/src/index.ts`
- `packages/sdk/src/job-model-types.ts`
- `packages/sdk/src/openapi-types.ts`
- `packages/sdk/src/settings.ts`

That matches the audit's declared AR3 one-way flow—contracts to Control OpenAPI
to generated SDK (`docs/architecture/ponytail-audit-2026-07-16.md:542-566`)—and
the F4/F17 paths (`ponytail-audit-2026-07-16.md:106-130,336-347`).

**There is no unavoidable AR3/F4/F17 file collision in the corrected media
design.** Existing settings schemas already carry generic agent `sources` and
`capabilities` (`packages/contracts/src/settings/index.ts:145-149`). Media setup
can write those existing fields through `SettingsDesiredStateService`; prompt
facts and toolchain status do not need a new public DTO. Therefore the goal
document's assertion that capability/settings merge risk is accepted is broader
than the tree proves.

Avoid touching the ten Phase 4 files above. If product scope later requires a
new public media/toolchain status response, defer that DTO until AR3 lands, then
define it first in `packages/contracts`, project it through the new
`openapi-contract-schemas.ts` helper, regenerate the SDK, and never hand-edit
generated types.

There **are branch-wide setup merge collisions** with Ponytail's already
committed Phase 1-3 work. The Ponytail branch differs from main in files the
correct media setup stage also needs:

- `apps/core/src/cli/setup-flow-state.ts`
- `apps/core/src/cli/setup-flow-final-steps.ts`
- `apps/core/test/unit/cli/setup-flow-simplified.test.ts`
- `apps/core/test/e2e/runtime-setup-doctor.e2e.test.ts`

Rebase/merge Ponytail before implementing the setup stage, or bound the media
diff to the post-Ponytail versions of these files. `packages/contracts/src/settings/index.ts`
and `packages/sdk/src/settings.ts` are also already changed on the Ponytail
branch, but media should not touch them if it uses the generic desired-state
shape.

## 4. Goal-document assumptions contradicted by the tree

1. **“`configd` is the one addition”** — false for the staged tree. Outer srt
   also needs `allowLocalBinding: true`, while Gantry currently fixes it to
   false.
2. **“Seed env in `agent-spawn-helpers.ts`”** — incomplete for direct Anthropic.
   The SDK adapter rebuilds `options.env` and currently drops HOME/cache keys.
3. **“Existing toolchain machinery” can provision the media stack** — false as
   an end-to-end claim. It is fleet-only, npm-only, and explicitly rejects
   system packages.
4. **“Declare it in fixed-image inventory” after setup provisioning** — category
   error. Setup-installed workstation content is not immutable worker-image
   content.
5. **“Existing admission preflight fails honest when absent”** — false when the
   image inventory env key is absent; admission skips the check.
6. **`buildLocalCliSemanticCapability` can express the sketched definition** —
   false as written. It creates one binding and hardcodes `credential_read`.
7. **Semantic sandbox metadata controls the runner sandbox** — false. The
   runner currently uses a fixed effective `required/workspace_write` profile.
8. **Two binary bindings are the full executable surface** — false. Remotion and
   the flag-enforcing wrapper/facade are also required, while Chrome should not
   be a direct user action.
9. **Bundled means enabled out of the box** — false. Bundled Claude skills are
   filtered by selected ids, and DeepAgents has no bundled-package source.
10. **Editing `OPERATING_GUIDANCE_BLOCK` makes it generated** — false. It is a
    static constant with no inventory/sandbox input, compiled before those
    worker facts exist.
11. **One-machine srt proof supports a general out-of-box claim** — false. The
    platform/architecture/download/hash matrix and direct Agent SDK proof are
    not defined.
12. **All direct providers can expose media rendering** — false. Direct
    DeepAgents rejects shell authority by design.
13. **“pnpm equivalent” is an existing hygiene requirement** — unsupported by
    this tree; the project setup and CI use npm.

## 5. Required Surface Impact Matrix for the corrected goal

The goal prompt omits the repository-mandated Surface Impact Matrix. Add this
before implementation:

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | New verified media facade, sandbox local-binding requirement, spawn env, and admission path. |
| `settings.yaml` | Changed | New agents receive readable attached skill/tool sources and durable `media.render` selection. |
| Postgres/runtime projection | Changed | Reviewed tool/skill definitions and active agent bindings must match the latest desired-state revision. |
| Control API | Unchanged by design | Existing generic settings/capability shapes are sufficient; no media-specific DTO. |
| SDK/contracts | Unchanged by design | No new public wire shape is needed; avoid Ponytail Phase 4 files. |
| CLI | Changed | Resumable setup toolchain step plus doctor status/repair action. |
| Gantry MCP/admin skill | Read-only/observable | Existing capability catalog/settings tools can expose the selected capability; no new admin mutation tool is required. |
| Channel/provider adapters | Unchanged by design | Delivery continues through the existing workspace-direct file path; no channel media API change. |
| Docs/prompts | Changed | Bundled selected skill, generated environment facts, setup/doctor documentation, supported platform matrix. |
| Audit/events | Changed | Provision success/failure, integrity failure, smoke result, and durable capability-selection evidence need structured audit/runtime evidence. |
| Tests/verification | Changed | Provision/hash/idempotence, composite inventory, admission, settings round trip, both skill projections, prompt facts, srt smoke, and direct live gate. |
| Transient approval | Unchanged by design | Out-of-box authority is a persistent new-agent selection, not an allow-once grant. |
| Persistent capability selection | Changed | Setup must select `media.render` only after verified provision and keep settings/revision/Postgres in sync. |

## Validation closeout

No implementation was performed. This report is the only worktree artifact
created by the validation pass. The next valid action is to correct the goal
prompt with the restaging above and run a second plan-validation gate before any
feature code is changed.
