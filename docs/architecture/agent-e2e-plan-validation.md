# Agent E2E CI Merge Gate — Plan Validation

Status: **NOT APPROVED FOR IMPLEMENTATION**

Validated: 2026-07-20

Scope: validation of `agent-e2e-ci-merge-gate-goal-prompt.md` against the current tree; no implementation.

## Executive verdict

The plan identifies a real coverage gap, but it is not decision-complete or internally consistent enough to implement.

The critical assumption is false: the current packaged runtime cannot complete a successful agent turn with no model credential. The Control API can durably accept a message, but both production execution lanes require a Gantry Model Gateway credential before execution, and the packaged adapter registry has no canned/model-test provider. Therefore the proposed always-required hermetic gate cannot prove a completed real turn, skill use, MCP use, or model-driven permission/capability behavior as written.

Several matrix rows also describe behavior that the current implementation does not have (`auto_strict` bypassing the classifier, command-name promotion, conversation-isolated durable grants, and capability network hosts as an egress allowlist). The named MCP fixture version does not exist. Finally, the current Postgres script omits two of the capability suites the plan says it will make gating.

| Component | Verdict | Required correction |
|---|---|---|
| CI reality and Postgres lane | **NEEDS-RESTAGE** | Wire the lane, but first correct its explicit test manifest, image handoff, and timing assumptions. |
| Packaged runtime / hermetic completed turn | **NOT-SAFE** | Choose and specify a packaged-compatible deterministic model boundary, or move completed-turn proofs to the live lane. |
| Granular permission matrix | **NEEDS-RESTAGE** | Rewrite rows to match current semantics and add only missing cross-boundary chains. |
| Granular capability matrix | **NEEDS-RESTAGE** | Preserve existing unit coverage; correct egress semantics and add the missing persistence-to-runtime chains. |
| Skill and MCP fixtures | **NOT-SAFE** | Vendor verified fixtures; replace the nonexistent MCP package version. |
| `i-have-adhd` exclusion | **SAFE** with a scoped guard | Scan only E2E-owned fixture/assertion surfaces and avoid a self-match. |
| Path-map, live matrix, merge protection | **NEEDS-RESTAGE** | Close UNKNOWN bypass, image provenance, fork-secret, and branch-protection gaps. |
| 15-minute required-gate budget | **NEEDS-RESTAGE** | Treat it as an unproven target until cold/warm measurements and sharding are specified. |

## 1. CI reality

Verdict: **NEEDS-RESTAGE**.

The plan is correct about the current top-level shape:

- CI provisions `pgvector/pgvector:0.8.2-pg16-trixie`, publishes a random host port, and creates `vector` and `pg_trgm` (`.github/workflows/ci.yml:19-48`).
- CI builds the runtime image with `docker compose ... build --pull` and inspects it, but never starts it (`.github/workflows/ci.yml:62-66`).
- CI runs `npm test`, `npm run test:e2e`, then exports `GANTRY_TEST_DATABASE_URL` and runs `npm run test:e2e:postgres`; it does not run `test:integration:postgres` (`.github/workflows/ci.yml:80-106`).
- The root scripts exist. `test:e2e` runs all files selected by `vitest.e2e.config.ts`; `test:e2e:postgres` requires the database environment and serially runs `claim-protocol-two-process.e2e.test.ts`; `test:integration:postgres` requires the database environment and serially runs a hard-coded 19-file integration list (`package.json:69-75`).

Adding the current `test:integration:postgres` command is mechanically straightforward because the job already has the required Postgres service and extensions. It does not require model credentials. It is not as complete or as cheap as the plan claims:

- The script includes `permission-promotion-postgres.integration.test.ts`, but omits both `fleet-capability-chaos-combo.postgres.integration.test.ts` and `fleet-capability-state-repositories.integration.test.ts`. It also omits `postgres-domain-repositories.integration.test.ts`, which contains capability secret and binding persistence coverage. Wiring the script unchanged would not make the named capability coverage gate.
- The Postgres harness reads `GANTRY_TEST_DATABASE_URL`, creates a unique schema, applies the full migration set for each runtime, and drops the schema during cleanup (`apps/core/test/harness/postgres-integration-runtime.ts:25-28,53-65,118-126`). A live disposable database is therefore a real dependency, not a skipped unit lane.
- The 19 files run with `--no-file-parallelism`. Some suites also use loopback servers and child processes. There is no checked-in timing evidence that the lane plus the new image harness fits the proposed gate budget.
- `GANTRY_TEST_DATABASE_URL` is exported only after `npm test`, so Postgres-conditional tests encountered by the earlier generic integration run do not supply the missing database evidence.

The current compose build produces the local tag `gantry-runtime:fleet-rehearsal` (`ops/docker/docker-compose.fleet.yml:42-47`). CI neither records an immutable digest nor exports an OCI artifact. If a new workflow/job must test the exact image built by existing CI, the plan must choose one of: keep build and test in one job, `docker save`/upload/download/load an immutable artifact, or publish a content-addressed PR image to a trusted registry.

## 2. Packaged-runtime harness and the credential blocker

Verdict: **NOT-SAFE**.

No existing test starts the exact production image with an isolated `GANTRY_HOME`, disposable Postgres, real migrations, a runtime restart, and a successfully completed Control API agent turn. That harness is genuinely net-new.

The closest existing tests each stop short at a different boundary:

- `runtime-setup-doctor.e2e.test.ts` uses an isolated home, but mocks the runtime entry path, platform, storage readiness, storage runtime, preflight, and service manager (`apps/core/test/e2e/runtime-setup-doctor.e2e.test.ts:71-196`). It does not start the image or run a turn.
- `claim-protocol-two-process.e2e.test.ts` uses real disposable Postgres and separate processes. Its “live” runner is a generated child script returning canned JSON, with configuration, credentials, prompt service, adapter, and channel supplied by the test (`apps/core/test/e2e/claim-protocol-two-process.e2e.test.ts:221-280,424-550`). It is valuable cross-process evidence, not a packaged production-provider turn.
- `session-control-runs.integration.test.ts` exercises a real HTTP route but replaces configuration, scheduler, storage, sessions, and runs with in-memory mocks; its shown scenario lists runs rather than executing a turn (`apps/core/test/integration/session-control-runs.integration.test.ts:1-89,95-125`).
- `inline-agent-runtime.integration.test.ts` is the closest composed turn: it uses Control API session/message routes and durable records with loopback MCP/gateway servers. It explicitly mocks the Anthropic SDK, DeepAgents, model factory, credential projection, admission, and other host boundaries (`apps/core/test/integration/inline-agent-runtime.integration.test.ts:30-145,328-366,1247-1305`).

A real Control API turn requires:

1. A bearer key with `sessions:write` to `POST /v1/sessions/ensure`, then `POST /v1/sessions/{sessionId}/messages` (`apps/core/src/control/server/routes/sessions.ts:139-193,246-305`).
2. `sessions:read` to observe events or wait for visible completion (`apps/core/src/control/server/routes/sessions.ts:309-435`).
3. A configured agent/conversation route, model alias and compatible harness, durable message admission, and a running queue. The message endpoint returns `202 accepted`; it does not mean the model turn completed (`apps/core/src/control/server/routes/sessions.ts:278-301`; `apps/core/src/control/server/session-interaction-adapter.ts:50-62`).
4. A usable model credential and provider execution boundary.

The image also sets `NODE_ENV=production` (`ops/docker/Dockerfile:55-63`). A harness must therefore supply isolated, non-production encryption and IPC secrets plus an enforcing `sandbox_runtime` configuration; the production security gate requires these independently of model access (`apps/core/src/shared/security-posture.ts:31-80`).

The fourth requirement makes the acceptance criterion impossible today:

- Runtime credential-broker mode defaults to `gantry` (`apps/core/src/config/settings/runtime-settings-defaults.ts:128-133`).
- Spawned and inline turns project model credentials before execution; inline setup returns a failure if projection fails (`apps/core/src/runtime/agent-spawn.ts:272-320`; `apps/core/src/runtime/agent-inline.ts:233-280`).
- The Gantry gateway throws when no active credential exists (`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts:135-154`).
- Setting broker mode to `none` does not produce a credential-free success: Anthropic rejects any non-Gantry projection, and DeepAgents rejects a non-Gantry or missing-auth-mode projection (`apps/core/src/adapters/llm/anthropic-claude-agent/model-provider-credential-validation.ts:5-18`; `apps/core/src/adapters/llm/deepagents-langchain/credential-validation.ts:18-49`).
- The packaged registry contains only the Anthropic and DeepAgents production adapters; there is no deterministic adapter/provider (`apps/core/src/adapters/llm/default-runtime-adapters.ts:34-43`).

Minimum design correction: explicitly choose one of these contracts.

- Keep the hermetic gate successful-turn complete by adding a supported, packaged-compatible deterministic model boundary that can drive exact tool calls without external credentials or internet. The plan must say how it is selected without a production-only test route, how its authority is constrained, and whether the production image/runtime surface changes.
- Keep the exact current production image and make the hermetic proof stop at boot, migrations, restart, desired-state projection, authenticated Control API admission, and deterministic non-model boundaries. Move successful turn/tool traces to the credentialed live lane.

Calling a `202` response a completed hermetic agent turn is not an acceptable substitute.

There is a second packaged-image mismatch. The bundled skill source looks for `.agents/skills/gantry-admin` (`apps/core/src/adapters/llm/anthropic-claude-agent/claude-skill-materializer.ts:39-68`), but the Docker build copies only `packages` and `apps`, and the runtime stage copies only production dependencies, `dist`, package metadata, and ops entrypoints (`ops/docker/Dockerfile:43-52,101-113`). The exact image currently omits `.agents`; the planned packaged-image `gantry-admin` proof therefore requires an explicit image-packaging correction or a changed scenario.

## 3. Granular permission matrix: existing coverage versus gaps

Verdict: **NEEDS-RESTAGE**.

All named permission test families exist: signed permission IPC, Postgres promotion counters, deterministic read-only gate, YOLO policy, classifier, locked IPC denial, tool gates, timeouts, and rule matching. The plan is right to wire and compose rather than rebuild them. However, four locked rows contradict current behavior:

- `auto` does evaluate the deterministic read-only gate and then consults the allow-leaning classifier. The gate is evidence for the classifier, not an absent stage (`apps/core/src/runtime/permission-classifier.ts:295-304,323-341`; `apps/core/test/unit/runtime/permission-classifier.test.ts:539-612`).
- `auto_strict` asks without classifier consultation when deterministic safety is unproven, but deterministic-proven input still calls the strict classifier. It does not auto-allow solely from the gate (`apps/core/test/unit/runtime/permission-classifier.test.ts:614-667`).
- A YOLO denylist hit returns `ask` and emits `permission.yolo_denylist_hit`; it is not universally “blocked.” An unattended/locked parent flow may convert that ask into denial, but the matrix must name that context (`apps/core/test/unit/runtime/permission-classifier.test.ts:868-941`).
- Durable command authority is `RunCommand(...)` argv-leaf scope, not a command-name class. The host suggestion shown for `npm test -- --runInBand` preserves that command shape, and runner policy requires every simple command leaf to match its own rule (`apps/core/test/unit/application/permission-suggestion-synthesis.test.ts:20-38`; `apps/core/src/runner/AGENTS.md:34-40`).

The claimed conversation isolation is also false for current authority. Persistent rules are saved as agent tool bindings; `conversationId` is recorded in the audit actor context, not in the binding identity (`apps/core/test/unit/jobs/request-permission-review.test.ts:429-505`). A rule is isolated from another agent, but not from another conversation bound to the same agent. The plan must either test current agent-wide semantics or explicitly propose a production authorization-model change.

| Permission area | Existing proof | Genuine remaining integration gap |
|---|---|---|
| Mode eligibility and classifier allow/ask/failure | Extensive unit coverage in classifier and eligibility suites | One chain through the real parent callback/IPC boundary, durable interaction, decision, and event repository. |
| Deterministic gate and YOLO | Unit coverage pins the actual `auto`/`auto_strict`/denylist behavior | Context-specific proof of attended prompt versus unattended denial. |
| Locked-agent forged IPC | `ipc-locked-permission-denial.test.ts` covers fail-closed parent behavior | Compose it with durable audit/pending-interaction storage if that is the claimed gate. |
| IPC authenticity and promotion counter | `permission-approval-ipc.integration.test.ts` covers signing/replay/redaction; Postgres promotion covers atomic count/offer/reset | The Postgres test only exercises counters (`permission-promotion-postgres.integration.test.ts:24-59`), not durable rule persistence or restart survival. |
| Persistent authority and security evidence | Unit tests cover rule synthesis, matching, agent binding, and prompt redaction | Restart survival, record-before-prompt ordering, current agent-wide scope, and whole-chain audit/log credential absence. |

The restaged matrix should cite the existing test for each already-proven row and add only the rightmost boundary gaps.

## 4. Granular capability matrix: existing coverage versus gaps

Verdict: **NEEDS-RESTAGE**.

The named fleet and repository tests exist, but they do not already prove the proposed end-to-end semantic capability matrix. Much of the logic is well covered in units:

| Capability area | Existing proof | Genuine remaining integration gap |
|---|---|---|
| Declaration and runtime rule projection | `configured-agent-tools.test.ts` projects `capability:<id>` and scoped `RunCommand(...)` rules (`:32-76,288-410`). | Persisted selected binding/catalog row through runtime policy projection and actual admission. |
| Local CLI contract | `semantic-capabilities.test.ts` validates pinned paths, narrow templates, preflight syntax, protected paths, and rule projection (`:226-342`); matcher tests deny unrelated commands. | Real-image executable inventory/preflight pass and fail-closed chain. |
| Sandbox and credentials | Spawn/configured-tool units cover protected-path/runtime-access projection; secret units cover decrypt and fail-closed integrity (`capability-secret-repository.postgres.test.ts:48-98`). | Selected capability through sandbox materialization plus unavailable credential behavior, without leaking plaintext. |
| Persistence | Postgres domain integration stores encrypted values and replaces agent capability/MCP/source bindings (`postgres-domain-repositories.integration.test.ts:154-194,603-830`). | Explicit store/retrieve/rotate/audit lifecycle; no current test proves all four stages. |
| Egress | Gateway units prove denylist blocking and `egress.connect` events (`egress-gateway.test.ts:492-510`). | Selected capability attribution through a real execution boundary and gateway. |

The proposed statement `networkHosts -> egress allow entries` is wrong. Current gateway behavior is default-allow for public hosts; `networkHosts` supplies reviewed capability attribution, not an allowlist. The tests explicitly allow undeclared public hosts even when capability hosts are present (`apps/core/test/unit/runtime/egress-gateway.test.ts:173-225`). Restaging must either describe and test this current contract or separately propose an egress authorization change.

The two fleet tests primarily cover repository state, bake/reconcile, and concurrency/convergence. They are useful but are not substitutes for the semantic capability chains above. They also are not in the current `test:integration:postgres` command.

## 5. Fixture feasibility and hermeticity

Verdict: **NOT-SAFE as written**.

The fixture contract conflicts with both package reality and the no-network lane:

- A fresh registry query for `@modelcontextprotocol/server-everything@2.0.0` returns `E404 No match found for version 2.0.0`; the published version list does not contain `2.0.0`. The package is absent from this repository's package manifest and lockfile.
- The runtime image deliberately removes `npm` and `npx` (`ops/docker/Dockerfile:89-91`). A packaged scenario cannot discover/install that server at runtime even if outbound internet were available.
- `internal-comms` and commit `fa0fa64bdc967915dc8399e803be67759e1e62b8` are not present in this tree, and the plan does not name an authoritative repository URL. The existing skill install API accepts an authenticated local `application/zip` payload and can install all archived assets (`apps/core/src/control/server/routes/skills.ts:54-119`); it does not require a network fetch.
- Current CI itself uses `npm ci` and Docker `--pull`. “No internet” must therefore be defined as no external network during hermetic test execution after dependency/image preparation, not necessarily no network in the entire job.

Required correction:

- Vendor the pinned skill fixture subtree, examples, license, provenance, source commit, and content hash, then build a deterministic checked-in/local zip for `/v1/skills/install`.
- Choose a real published MCP version with integrity and vendor/prebuild its complete runtime closure, or extend the existing in-process Streamable HTTP test server pattern (`inline-agent-runtime.integration.test.ts:328-357`) with `echo` and `get-sum`.
- Prohibit `git fetch`, `npm install`, `npx`, or registry access during the hermetic test execution phase and verify that with the harness network boundary.

Even with valid local fixtures, a model-directed assertion such as producing the 3P format or selecting `get-sum` still depends on the deterministic model-boundary decision in section 2.

## 6. `i-have-adhd` exclusion

Verdict: **SAFE with a scoped correction**.

The named folder exists in the primary checkout as untracked local content; it is not a Git-tracked repository asset and is absent from this worktree. Current tracked references are planning-document references only. Runtime skill discovery reads managed artifact projections and known skill roots such as `.agents/skills`; it does not discover an arbitrary repository-root `i-have-adhd` folder. The Dockerfile also does not copy that folder.

A guard is feasible, but “zero references” must be scoped to the E2E fixtures, manifests, prompts, snapshots, and assertions named by the acceptance criterion. A whole-repository scan would correctly find the goal prompt and goals index. The guard source must construct the forbidden token from fragments or exclude itself so its own assertion does not create the only match.

No E2E should inspect or copy the external folder's contents.

## 7. Path-map policy, live matrix, and required merge gate

Verdict: **NEEDS-RESTAGE**.

There is no current workflow, path-map, label implementation, aggregator, or repository-local ruleset for `agent-e2e-gate`; these are net-new. The policy design has four unresolved security/operational gaps:

- UNKNOWN is not fully fail-closed if `e2e-reviewed` can bypass classification and thereby avoid `live-agent-e2e`. UNKNOWN must remain risky for live-gate purposes until the path map is updated or a separate explicit risk classification is recorded. A review label may acknowledge the mapping miss; it must not silently downgrade unknown code.
- A workflow check is not a required merge gate by itself. Branch protection/ruleset configuration is external repository state. The goal must include enablement and verification of the exact required check name, or a repository-managed ruleset if this repository uses one.
- The “exact previously-built image digest” contract lacks a cross-job artifact/publish mechanism. Rebuilding in the live job is not the same artifact.
- Protected model secrets must never be exposed to untrusted fork PR code. Specify the trust boundary: for example, same-repository PRs plus protected-environment approval, or a trusted workflow that executes an already-built reviewed artifact. Do not solve this with an unsafe `pull_request_target` checkout of PR code.

The semantic base/head catalog diff is feasible, but the goal must name its inputs, output schema, comparison rules, and how deleted/renamed aliases are classified. The current prose is not yet an executable policy contract.

The Surface Impact Matrix also needs correction: CI workflow/ruleset state and image packaging are **Changed**, not implicit. Runtime behavior is **Changed** if a deterministic provider becomes part of the exact packaged image. “Deployment workflows” may remain deferred for deployment automation, but pre-merge workflow and GitHub protection are in scope and must have their own row.

## 8. Fifteen-minute budget

Verdict: **NEEDS-RESTAGE**.

The 15-minute warm-cache target is plausible only as an optimization goal, not as a validated acceptance criterion:

- The existing monolithic CI job allows 30 minutes, and its helper allows each test command up to 900 seconds (`.github/workflows/ci.yml:19-21,86-100`).
- The new gate adds image availability/startup, migrations, health, desired-state setup, restart, completed-turn waiting, evidence collection, the serial 19-file Postgres lane, and new integration tests.
- The compose readiness policy alone permits a 60-second start period plus 30 five-second retry intervals (`ops/docker/docker-compose.fleet.yml:98-110`). The entrypoint runs migrations before starting the runtime (`ops/docker/entrypoint.sh:193-225`).
- Current CI uses a plain `docker compose build --pull`; no explicit Buildx layer-cache or image artifact handoff is configured.

Restage with separate wall-clock budgets per parallel shard, a Docker cache/artifact strategy, and measured cold-cache and warm-cache baselines. If the cold required gate cannot reliably finish below 15 minutes with headroom, raise the timeout rather than making a flaky performance promise.

## Minimum restage set

1. **Resolve the hermetic turn contract.** Specify a deterministic packaged model boundary that can complete exact tool traces without external credentials, or narrow hermetic scope and move completed agent turns to the live lane. Include the missing `.agents/skills/gantry-admin` image packaging decision.
2. **Correct and deduplicate both matrices.** Pin current permission scope/classifier/YOLO and egress semantics, map every already-covered row to its test, add only chain/restart/audit gaps, and update `test:integration:postgres` so the intended Postgres suites actually run.
3. **Make fixtures genuinely offline and valid.** Vendor the licensed/pinned skill payload, replace the nonexistent MCP version with a verified vendored fixture or in-process server, and enforce no external network during test execution.
4. **Seal the merge-policy trust boundary.** Define immutable image transfer, UNKNOWN-as-risky behavior, safe fork/protected-secret handling, semantic-diff mechanics, and branch-protection/ruleset activation and verification.
5. **Rebaseline the budget and Surface Impact Matrix.** Measure cold/warm shard timings, specify cache/parallelization, and classify CI/ruleset/image/runtime changes according to the chosen design.

## Overall decision

**NOT APPROVED FOR IMPLEMENTATION.** The minimum restage set above is required before the goal prompt is decision-complete. The highest-priority blocker is the impossible-as-written combination of “successful packaged real agent turn” and “no model credentials” with the current production adapter and credential architecture.
