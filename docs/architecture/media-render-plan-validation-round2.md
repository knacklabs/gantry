# Media render goal plan validation — round 2

Date: 2026-07-20

Validated target: `feature/media-render-capability` at
`eb392cff5418ca9f4e57eb1f927c406fa630553a`.

## Verdict

**Overall: NOT APPROVED FOR IMPLEMENTATION.**

V2 fixes most of the round-1 tree mismatches, and Stages 2 and 4 now point at
the right basic mechanisms. It is still not safe to implement as staged. The
blocking issue is Stage 3: the proposed composite inventory is neither faithful
to the current fixed-image contract nor capable of expressing the deployment,
provider, and sandbox qualification required by v2's own hard gates. Stage 3
would select and advertise `media.render`, but no pre-Stage-3 stage owns the
direct lane gate. The current flat worker inventory also cannot represent
“available under `sandbox_runtime`, unavailable under direct DeepAgents, direct
Anthropic not yet proven.”

| Stage | Verdict | Required disposition |
| --- | --- | --- |
| 1 — sandbox + env | **NEEDS-RESTAGE** | Narrow the local-binding claim to the outer srt boundary, split generic sandbox plumbing from Stage-3 capability wiring, name the actual temp-directory seam, and preserve host Claude executable resolution when `HOME` changes. |
| 2 — provisioner + inspector | **SAFE** | Safe as a workstation-only stage. Keep it independent of the fleet bake executor and avoid whole-archive `Uint8Array` materialization as v2 says. |
| 3 — capability + inventory + selection | **NOT-SAFE** | Replace the flat “composite inventory” with a source- and route-aware availability check, explicitly scope v1 to workstation or design fleet rollout, cover both worker-advertisement write sites, and move all applicable smoke gates before selection/advertisement. Seal the runtime-asset extension; do not leave “extend or bypass” open. |
| 4 — selected skill | **NEEDS-RESTAGE** | Use `SkillService.installSkill`, retain its exact returned `skill:<uuid>`, and select it through the revision-owned desired-state writer in this stage. A direct DB binding is not durable desired-state authority. |
| 5 — environment facts | **NEEDS-RESTAGE** | Separate execution provider/harness from sandbox provider in the typed facts. Assign the currently unowned direct-advertisement gate before Stage 3 selection rather than leaving it as a closeout ambiguity. |

## Blocking and material findings

### 1. The proposed composite inventory is incompatible with the current inventory contract

The current helper is explicitly fixed-image-only: it describes immutable
image content and distinguishes availability from authority
(`apps/core/src/shared/worker-image-inventory.ts:1-6`). Its return type has a
second semantic dimension: `undefined` means the image inventory was not
declared, whereas a declared malformed or empty value becomes `[]`
(`worker-image-inventory.ts:8-35`). The comparison then treats the declared
list as exhaustive for every selected semantic capability
(`worker-image-inventory.ts:37-49`).

That contract cannot safely be changed to a flat merge of fixed-image and
workstation-provisioned ids:

- Preserving `undefined` preserves the round-1 fail-open path. Spawn admission
  returns success without checking anything when the image env key is absent
  (`apps/core/src/runtime/agent-spawn-admission.ts:155-169`).
- Returning `[]` or `['media.render']` to make provisioned availability
  authoritative makes the list exhaustive and can reject unrelated selected
  semantic capabilities that were never image-owned.
- Job readiness has the same optional/exhaustive behavior
  (`apps/core/src/application/jobs/job-readiness-service.ts:519-545`) and emits
  image-rebuild remediation (`job-readiness-service.ts:548-556`), which is
  wrong for a repairable workstation toolchain. It also deliberately excludes
  known local-CLI requirements from the image check (`:540-543`), so merely
  replacing the image array does not make the provisioned inspector govern
  this facade.

The lighter correct shape for v1 is to leave `readImageCapabilityInventory()`
unchanged and add one dedicated media availability inspector returning a small
typed result (available/unavailable reason, verified manifest identity, and
applicable run lane). Spawn admission, workstation job readiness, doctor,
worker registration, and environment facts can consult that result explicitly.
Do not generalize a second all-capability inventory until there is a second
provisioned capability with the same lifecycle.

### 2. V2 omits a live worker-advertisement writer

There are four current imports of `readImageCapabilityInventory`, not three:

1. spawn admission (`agent-spawn-admission.ts:156`),
2. job readiness (`apps/core/src/jobs/execution-readiness.ts:53-64`),
3. initial worker registration (`apps/core/src/jobs/worker-identity.ts:23-37`),
4. the worker capability reconciler (`apps/core/src/jobs/worker-capability-reconciler.ts:217-227`).

Doctor and prompt facts would be new consumers. V2 may group the two worker
sites under the conceptual label “worker advertisement,” but the implementation
plan must name both. The reconciler re-advertises from fixed-image inventory plus
its activated fleet artifacts; if only initial registration is changed, a later
reconcile can overwrite the media advertisement.

### 3. Deployment mode and run lane are missing from the availability model

The new provisioner is explicitly workstation-local, and the existing bake
subsystem is explicitly fleet-only (`apps/core/src/jobs/toolchain-bake-bootstrap.ts:41-53`).
A setup-time activation under the control host's `ARTIFACTS_DIR` says nothing
about availability on every fleet worker. Yet v2 feeds worker advertisement and
job readiness without declaring whether fleet is deferred.

The current worker registry accepts only a flat `capabilities: string[]`
(`apps/core/src/jobs/worker-identity.ts:30-37`). It cannot distinguish:

- workstation from fleet,
- Anthropic SDK from DeepAgents,
- direct from `sandbox_runtime`, or
- proven from not-yet-proven direct Anthropic execution.

This directly conflicts with the hard gate at goal lines 181-187. Stage 3 says
to select and advertise after verification, but no stage before it owns the
real direct Anthropic gate; that requirement appears only in the separate hard-
gates section after the five-stage list. A direct-configured workstation could
therefore select/advertise the capability before the required direct proof. A flat
advertisement also cannot express v2's honest-unavailable direct DeepAgents
lane.

Concrete correction: explicitly scope the first implementation to
`runtime.deploymentMode: workstation`; defer fleet worker distribution and
advertisement. Make the media inspector accept the actual execution
provider/harness and sandbox provider. Run every gate required by the current
configured route before Stage 3 selection. If both srt harnesses are claimed,
their separate smoke evidence must exist before they are reported available.
If fleet remains in scope, it needs a separate worker-distribution and
lane-aware scheduling design; the workstation setup provisioner is not enough.

### 4. Stage 1's local-binding claim is too broad

The proposed outer-sandbox seam is correct. `RunnerSandboxSpawnInput` is the
right host-to-provider contract (`apps/core/src/shared/runner-sandbox-provider.ts:33-49`),
and the srt warm template currently fixes `allowLocalBinding` to false
(`apps/core/src/adapters/sandbox/runner-sandbox-provider.ts:21-26,160-178`).
`buildSandboxRuntimeConfig` is also the correct place to emit the effective
nested network keys (`runner-sandbox-provider.ts:226-267`).

However, “true ONLY for runs with `media.render` selected” and “non-media runs
keep local binding false” are not true across all current lanes. The direct
Anthropic SDK sandbox already sets `allowLocalBinding: true` for every sandboxed
SDK run (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/filesystem-sandbox.ts:68-91`).
`RunnerSandboxSpawnInput` governs the outer runner sandbox, not that inner SDK
configuration. Narrow the Stage-1 statement and test to outer
`sandbox_runtime`; changing the direct SDK default would be a separate provider
adapter behavior change requiring its own proof.

Stage 1 also cannot cleanly derive a generic sandbox requirement from the
reviewed capability because the runtime-access extension is deferred to Stage
3. Do not hard-code `media.render` in the core spawn builder. Stage 1 should add
the generic `allowLocalBinding`/Mach-lookup input and adapter tests; Stage 3
should project that requirement from the reviewed selected capability once the
internal capability contract exists.

### 5. The workspace env correction names the wrong creation seam and creates a Claude lookup regression

V2 correctly identifies `buildSdkEnv` as the Anthropic env boundary: it copies
PATH and temp variables but currently omits HOME and npm cache
(`apps/core/src/adapters/llm/anthropic-claude-agent/runner/runtime-env.ts:206-244`).
The base runner env currently forwards a temp directory only when one is
provided (`apps/core/src/runtime/agent-spawn-helpers.ts:56-115`).

Two corrections are still required:

1. Per-run temp creation is not in `agent-spawn-helpers.ts`. It is owned by
   `apps/core/src/runtime/agent-spawn-temp-directories.ts:5-16`, currently
   creates `/tmp/gantry-srt-*`, and returns no directory in direct mode. Restage
   that seam (or name a new workspace-env-path helper) and distinguish the
   persistent HOME/npm-cache directories from the cleanup-owned per-run temp.
   `agent-spawn.ts:509-527,769-797` shows both creation and cleanup ownership.
2. In outer srt, the runner resolves the Claude executable from PATH and
   approves home-installed executables using `process.env.HOME`
   (`runner/runtime-env.ts:246-285`; `runner/query-loop.ts:303-308`). Once HOME
   is rewritten to `<workspace>/.gantry/home`, an existing Claude installation
   under the real host `~/.local/share/claude/versions` is no longer inside an
   allowed root. This machine uses that installation layout. Preserve a
   host-validated executable path or the original approved host-home root
   independently of the agent-facing HOME, and add a regression test for the
   `.local/bin`/`.local/share/claude/versions` case.

Because HOME changes every provider runner, tests must cover both harnesses and
both sandbox providers, not only “direct SDK env receives” the variables. If the
global HOME change is not required outside media runs, the smaller blast radius
is to media-gate HOME/npm cache and make only per-run temp hygiene global.

### 6. “Extend or bypass” is not a sealed capability design

V2 now correctly acknowledges the builder limitation. The builder emits one
local-CLI binding and hardcodes `credential_read`
(`apps/core/src/shared/semantic-capabilities.ts:278-330`), while the runtime
access type exposes only command rules, credential directories, and network
bindings (`apps/core/src/shared/capability-runtime-access.ts:19-24`). The
projection maps `protectedPaths` into credential directories
(`apps/core/src/application/agents/agent-tool-runtime-rules.ts:178-196`), and
spawn turns those into runner read paths and protected write paths
(`apps/core/src/runtime/agent-spawn-helpers.ts:340-395`).

The remaining alternative “extend or bypass” is not safe. Bypassing the builder
or reviewed local-CLI validation risks skipping the required absolute path,
version, executable hash, and narrow command-template checks
(`semantic-capabilities.ts:380-424`). Seal the plan to one generic internal
extension: add explicit read-only runtime-asset directories and the required
outer-sandbox local-binding signal to the semantic definition/runtime-access
projection, preserve local-CLI validation, add the asset root to runner read
paths/additional directories, and always include it in deny-write paths. This
does not require a public SDK or Control API DTO.

### 7. Stage 4 must say how the skill becomes durable desired state

The durable catalog/artifact mechanism is now correct. `SkillService.installSkill`
is idempotent by materialization identity, writes the artifact, and returns the
authoritative generated skill id (`apps/core/src/application/skills/skill-service.ts:37-104`).
Both provider projections require selected durable ids: the shared projection
rejects ids that are not enabled/materializable (`apps/core/src/application/skills/selected-skill-projection.ts:36-104`),
Anthropic filters its composite sources by selected ids
(`apps/core/src/adapters/llm/anthropic-claude-agent/execution-adapter.ts:83-96,180-215`),
and DeepAgents uses the same selected durable projection
(`apps/core/src/adapters/llm/deepagents-langchain/skill-projection.ts:22-60`).

But “seeded ... and SELECTED” does not name the authority write. A direct
`bindSkillToAgent` DB write is insufficient because the latest settings
revision will replace bindings from `agent.sources.skills`
(`apps/core/src/config/settings/desired-state-capability-reconcile.ts:43-107`).
Stage 4 must add the exact returned `skill:<uuid>` to the new agent's desired
skill sources through `writeDesiredRuntimeSettings`, so revision append,
Postgres reconcile, and `settings.yaml` sync occur together
(`apps/core/src/config/settings/desired-settings-writer.ts:58-129`).

### 8. Typed environment facts use two distinct axes, not “direct SDK vs outer srt” as a provider

The proposed compilation seam is faithful. The operating-guidance block is
currently static (`apps/core/src/application/agents/prompt-profile-service.ts:227-252,384-445`),
and `compileSpawnSystemPrompt` has no facts input
(`apps/core/src/runtime/agent-spawn-prompt.ts:11-44`). There are exactly two
production call sites: worker spawn compiles before adapter preparation
(`apps/core/src/runtime/agent-spawn.ts:224-260`) and inline preparation compiles
after model resolution (`apps/core/src/runtime/agent-spawn-host.ts:143-196`).
Threading a typed value through those sites is the lightest correct change.

The type must not call “direct SDK vs outer srt” the effective provider. Current
tree concepts require separate fields for execution provider/harness and
`RunnerSandboxProviderId`. Availability and prose should be derived from both,
plus the typed media-inspector result. Compute the pure facts after model
resolution/admission and before prompt compilation; do not move credential or
adapter side effects earlier merely to construct prompt text.

### 9. Surface Impact Matrix correction

`Channel/provider adapters | Unchanged by design` is contradicted by Stage 1.
`buildSdkEnv` lives inside the Anthropic Claude execution adapter and must
change. Reclassify this row as **Changed**, with the narrow reason “Anthropic
SDK env projection forwards approved workspace HOME/tmp/npm-cache values;
channel delivery adapters remain unchanged.”

The SDK/contracts row can remain unchanged only if the runtime-asset and
sandbox-requirement fields stay inside Gantry's internal semantic/runtime-access
contracts. The plan should also add a deployment-mode row: workstation changed;
fleet deferred unless a real fleet rollout is designed.

## Disposition of the 13 round-1 contradictions

| # | Round-2 disposition | Evidence / remaining issue |
| --- | --- | --- |
| 1 | **Resolved, with a new overbroad claim** | V2 now records both outer-srt deltas (`allowLocalBinding` and `configd`). Its new “ONLY/non-media false” wording must be narrowed because direct SDK already enables local binding globally. |
| 2 | **Resolved in intent; Stage 1 still needs correction** | V2 names `buildSdkEnv`. It names the wrong directory-creation owner and does not preserve host-home Claude executable approval. |
| 3 | **Resolved** | V2 calls for a dedicated workstation provisioner and only reuses normalization/hash/atomic/quarantine conventions. This matches the fleet-only bootstrap and buffered artifact-store implementation. |
| 4 | **Partially resolved — survives** | V2 distinguishes fixed-image from provisioned evidence, but then flattens them into one inventory without preserving provenance or optional/exhaustive semantics. |
| 5 | **Not resolved — survives** | V2 promises honest absence but does not define a source-aware fail-closed contract. The current admission and job paths still skip when inventory is undeclared. |
| 6 | **False assumption removed; implementation decision unsealed** | V2 acknowledges the single-binding/`credential_read` limitation. It must choose the generic internal extension and delete “or bypass.” |
| 7 | **Resolved** | V2 explicitly carries effective outer-sandbox input through `RunnerSandboxSpawnInput`; semantic selection must be wired in Stage 3 rather than hard-coded in Stage 1. |
| 8 | **Resolved** | One narrow `media-render` facade is the only user-facing binding; Chrome, ffmpeg, Remotion, and the enforcing wrapper remain internal. |
| 9 | **Resolved in architecture; Stage 4 write path missing** | Durable catalog/artifact selection is the correct provider-neutral carrier. Stage 4 must explicitly use revision-owned desired state. |
| 10 | **Resolved** | V2 adds typed run facts through `CompilePromptProfileOptions`/`compileSpawnSystemPrompt` rather than editing only the static constant. |
| 11 | **Partially resolved — gate ownership survives** | The platform matrix and separate hard gates fix the evidence overclaim, but the direct proof is not assigned before Stage-3 advertisement. Fleet vs workstation remains unspecified. |
| 12 | **Resolved/scoped out** | Direct mode is limited to Anthropic SDK; direct DeepAgents remains fail-closed, matching `deepagents-shell-filesystem-guard.ts:102-150`. |
| 13 | **Resolved/scoped out** | V2 is npm-only. |

Surviving round-1 contradiction classes: **#4, #5, and the gate-order portion
of #11**. #6 is no longer a false assertion, but its open “bypass” alternative
is a new implementation blocker. The Stage-1 direct-lane wording and HOME
regression are new round-2 findings.

## Stage-by-stage seam validation

### Stage 1 — NEEDS-RESTAGE

Faithful seams:

- `RunnerSandboxSpawnInput` to `buildSandboxRuntimeConfig` is the correct outer
  sandbox route for media-gated local binding and nested `configd` lookup.
- `buildBaseRunnerEnv` plus Anthropic `buildSdkEnv` is the required two-boundary
  route for agent-facing env.

Corrections required:

- Qualify local-binding assertions as outer srt; direct SDK differs today.
- Add only generic sandbox plumbing in Stage 1 and wire capability-derived
  requirements in Stage 3.
- Replace the stale `agent-spawn-helpers.ts` creation claim with the actual
  temp lifecycle seam.
- Preserve the host-validated Claude executable across HOME replacement.
- Decide whether HOME/npm-cache are truly global; test every affected harness
  and sandbox provider.

### Stage 2 — SAFE

The dedicated provisioner is justified and appropriately smaller than adapting
the fleet bake pipeline. Existing toolchain ports use in-memory `Uint8Array`
files (`apps/core/src/domain/ports/toolchain-artifact-store.ts:5-33`), the local
store buffers and rewrites the whole file set
(`apps/core/src/adapters/artifacts/toolchains/local-toolchain-artifact-store.ts:35-70,73-134`),
and the bake executor is npm-package-oriented
(`apps/core/src/jobs/toolchain-bake-executor.ts:65-75,119-128`). V2 correctly
rejects reusing that executor for a browser archive.

`ARTIFACTS_DIR` already owns the artifact root
(`apps/core/src/config/index.ts:234`), and the existing helper establishes the
content-addressed `toolchains/<sanitized-hash>` convention
(`apps/core/src/adapters/artifacts/toolchains/toolchain-artifact-bundle.ts:99-110`).
The proposed setup insertion is faithful: `FULL_SEQUENCE` currently places
`group` immediately before `verify` (`apps/core/src/cli/setup-flow-state.ts:27-41`),
the dispatcher has an explicit branch for each step
(`apps/core/src/cli/setup-flow.ts:86-145`), and `runGroupStep` establishes the
agent/conversation before `runVerifyStep` invokes doctor
(`apps/core/src/cli/setup-flow-final-steps.ts:129-198`).

This verdict is for workstation provisioning only. Fleet is not implicitly
made safe by this stage.

### Stage 3 — NOT-SAFE

The one-facade decision and explicit read-only runtime-asset projection are
correct. The inventory, route qualification, deployment scope, selection
ordering, and open builder alternative are not. Apply Findings 1-6 before this
stage can be handed off.

The desired-state portion itself is faithful: new agents currently have empty
sources/capabilities (`apps/core/src/config/settings/runtime-settings.ts:142-151`),
and the desired writer is the single revision/reconcile/file-sync route. The
selection must occur only after the route-applicable verification evidence
exists, not merely after the srt smoke.

### Stage 4 — NEEDS-RESTAGE

The durable catalog/artifact carrier and both provider projections are faithful.
Add the exact `SkillService.installSkill` plus desired-state selection sequence
from Finding 7. Do not introduce a new skill-source abstraction and do not use a
DB-only binding.

### Stage 5 — NEEDS-RESTAGE

The typed `EnvironmentFacts` route through `compileSpawnSystemPrompt` is
faithful and preferable to another prompt global. Separate provider/harness
from sandbox provider, keep fact construction pure, and make locked-agent facts
physical/status-only as v2 says. Assign the real direct smoke gate before Stage
3; Stage 5 should validate rendering/determinism and close out, not become the
first point at which an already advertised capability is proven.

## Ponytail collision re-check

Current live Ponytail worktree:

- path: `scratchpad/wt-ponytail`
- branch: `feature/ponytail-audit`
- committed HEAD: `61a18b87df025f5e93bb1583a75603a6de5b7553`
- committed HEAD has **not advanced** since round 1.
- current uncommitted Phase-4 state has expanded to 18 paths: `.github/workflows/ci.yml`, the OpenAPI schema/helper set, `packages/contracts/src/jobs/index.ts`, `packages/contracts/src/settings/index.ts`, `packages/contracts/test/unit/index.test.ts`, and multiple `packages/sdk` files.

V2's four committed setup collisions remain correct:

- `apps/core/src/cli/setup-flow-state.ts`
- `apps/core/src/cli/setup-flow-final-steps.ts`
- `apps/core/test/unit/cli/setup-flow-simplified.test.ts`
- `apps/core/test/e2e/runtime-setup-doctor.e2e.test.ts`

The rule to avoid Ponytail's dirty OpenAPI/contracts/SDK files remains sound.
One new conditional collision must be made explicit: Ponytail currently has an
uncommitted `.github/workflows/ci.yml` change. If “linux-x64 (CI-verifiable)” in
v2 requires a workflow edit, that file is now a live collision; otherwise say
that the verification runs inside the existing CI commands and the workflow is
unchanged.

Ponytail's committed branch also relocates desired-state/runtime-settings seams
that Stages 3-4 rely on, including `desired-state-capability-reconcile.ts`,
`desired-state-service.ts`, `desired-state-service-types.ts`, and runtime settings
types. Therefore, if Ponytail lands first, re-resolve all Stage-3/4 imports and
line references against post-Ponytail main rather than mechanically replaying
the current paths. The safest collision strategy remains: implement in this
separate worktree, keep the four setup diffs minimal, do not touch the dirty
Phase-4 files, and revalidate/rebase against the landed Ponytail tree before
closeout.

## Required v3 restage, minimum set

1. Scope v1 to workstation, or add a real fleet distribution/qualification
   design. Do not imply workstation setup provisions fleet workers.
2. Preserve fixed-image inventory unchanged. Add a dedicated, route-aware media
   availability inspector and name every integration site, including both
   worker advertisement writers.
3. Move all route-applicable live smoke gates before durable selection and any
   advertisement. An unowned closeout gate cannot justify Stage-3 selection.
4. Seal the capability shape: extend the reviewed local-CLI/runtime-access
   contract for read-only asset paths and outer local binding; remove “bypass.”
5. Restage Stage 1's temp owner, outer-srt-only binding claim, host Claude path
   preservation, and test matrix.
6. Make Stage 4's exact skill id part of the revision-owned desired-state write.
7. Model execution provider/harness and sandbox provider as separate environment
   fact fields.
8. Correct the Surface Impact Matrix provider-adapter row and add deployment
   mode. Clarify whether CI workflow changes are required, because that affects
   the current Ponytail collision set.

No implementation or runtime claim was treated as proven merely because it is
present in the plan. The darwin-arm64 srt render remains plan-supplied empirical
evidence; the linux-x64, direct Anthropic, and srt DeepAgents claims remain
unverified at this HEAD and must stay behind their stated gates.
