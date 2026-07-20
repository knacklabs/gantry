# Agent E2E CI Merge Gate — Plan Validation Round 2

Status: **NOT APPROVED FOR IMPLEMENTATION**

Validated: 2026-07-20

Scope: fresh validation of `agent-e2e-ci-merge-gate-goal-prompt.md` v2
against the current tree. This report is the only file changed.

## Executive verdict

V2 accurately corrects the round-1 permission and capability semantics, and its
high-level merge-policy trust rules are materially safer. It does not, however,
resolve the key model boundary in the current runtime.

A desired-state model alias can name only a model **provider**. That provider's
static registry entry chooses an execution adapter. In the worker path, the host
then projects credentials before the selected adapter's `prepare()` method runs.
With the default `gantry` broker, the gateway requires an active credential for
the selected route and throws before a new deterministic adapter can bypass or
ignore it. The production adapter credential validators are adapter-local, so a
new adapter can avoid those validators; it cannot avoid the earlier gateway
call merely by being registered or selected by alias.

Two other round-1 items also remain blocking. The chosen `/v1/skills/install`
path cannot install `gantry-admin` because that name is deliberately reserved,
and the budget section repeats the requirement for measured baselines and
per-shard limits without supplying either.

| Component | Verdict | Round-2 result |
|---|---|---|
| Deterministic model boundary | **NOT-SAFE** | Adapter registration plus an alias does not bypass the default gateway; the credential-free route contract is missing. |
| Permission/capability semantic matrices | **SAFE** | The six named round-1 corrections now match the tree. |
| Offline fixtures | **NEEDS-RESTAGE** | Local fixture shapes are viable, but exact skill provenance and the container/MCP/no-internet topology are not locked. |
| Image provenance | **NEEDS-RESTAGE** | Exact-image intent is correct, but v2 still leaves artifact versus registry transfer open and does not bind the transfer contract to the current head SHA. |
| `gantry-admin` image packaging | **NOT-SAFE** | The generic install API rejects the reserved `gantry-admin` materialization name. |
| Merge-policy trust boundary | **NEEDS-RESTAGE** | UNKNOWN/no-`pull_request_target`/protected-secret rules are sound; exact ruleset activation and fork-artifact execution constraints are incomplete. |
| Budget rebaseline | **NEEDS-RESTAGE** | No shard budgets, cache choice, or cold/warm measurements are present. |
| Surface Impact Matrix | **NEEDS-RESTAGE** | The provider-adapter row uses non-contract statuses and calls a new provider merely observable. |

## 1. Model boundary — still the critical blocker

Verdict: **NOT-SAFE**.

### What alias selection can do

Custom desired-state aliases carry `provider` and `provider_model_id`; they do
not carry an execution-adapter id. Parsing normalizes `provider` against the
static provider registry, and catalog construction maps it to a provider route
(`apps/core/src/config/settings/runtime-settings-model-aliases-parser.ts:46-71,105-157`;
`apps/core/src/shared/model-provider-registry.ts:480-499`). The provider's
`executionRoute.executionProviderId` is then the only alias-to-adapter bridge
(`apps/core/src/shared/model-execution-route.ts:32-65`).

Therefore v2 needs more than adding an adapter to
`createDefaultAgentExecutionAdapterRegistry()`, whose current packaged entries
are only Anthropic and DeepAgents
(`apps/core/src/adapters/llm/default-runtime-adapters.ts:34-43`). It also needs a
registered model-provider route that maps the deterministic provider to that
adapter. V2 says the alias is "routed to it" but never specifies this required
provider-registry addition or its credential semantics.

### Where the gateway blocks it

The default settings use `credentialBroker.mode = 'gantry'`
(`apps/core/src/config/settings/runtime-settings-defaults.ts:128-133`). The
worker path resolves the execution adapter, then unconditionally calls
`getHostRuntimeCredentialEnv`, and only after that invokes the adapter's
`prepare()` method (`apps/core/src/runtime/agent-spawn.ts:254-320`). With the
default mode, credential projection invokes the Gantry broker
(`apps/core/src/runtime/agent-spawn-host.ts:214-243`). The gateway looks up the
selected route's provider credential and throws if none is active
(`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts:135-154`).

This answers the key feasibility question precisely:

- The **credential-projection call** currently sits in front of every worker
  adapter.
- The **gateway** sits in that path whenever the global broker mode is the
  default `gantry` mode.
- Adapter selection by alias does not turn the gateway off and there is no
  adapter-level `credentialRequirement: none` seam today.
- `model_access.enabled: false` is an existing global escape hatch: it returns
  an empty `brokerProfile: 'none'` projection instead of calling the gateway
  (`apps/core/src/config/settings/runtime-settings-parser.ts:435-483`;
  `apps/core/src/application/credentials/agent-credential-service.ts:110-118`).
  It is not alias-selective, v2 does not require it in the hermetic desired
  state, and current model preflight explicitly fails when the broker mode is
  not `gantry` (`apps/core/src/adapters/llm/model-provider-preflight.ts:64-77`).

The named credential-validation gates do not rescue or independently block a
proper new adapter. Anthropic validates a Gantry loopback/token projection
inside its adapter (`apps/core/src/adapters/llm/anthropic-claude-agent/execution-adapter.ts:53-72`;
`model-provider-credential-validation.ts:5-44`), and DeepAgents performs its own
adapter-local Gantry/auth-mode validation
(`apps/core/src/adapters/llm/deepagents-langchain/execution-adapter.ts:75-97`;
`credential-validation.ts:18-62`). A deterministic adapter can omit those two
production-specific validators, but it still cannot reach `prepare()` under the
default broker without an active gateway credential.

The inline path is a separate unresolved boundary. It also obtains credentials
before execution (`apps/core/src/runtime/agent-inline.ts:233-248`) and dispatches
only between the Claude and DeepAgents lanes by engine, not through the worker
adapter registry (`apps/core/src/adapters/llm/inline-lane-dispatcher.ts:151-175`).
V2 must pin the hermetic agent to `runtime: worker`; registering a worker adapter
does not make an inline deterministic lane.

### Required correction

V3 must choose one of two coherent shapes:

1. **Lighter:** keep the exact-image hermetic gate at boot, migrations, restart,
   desired-state projection, authenticated admission, skill/MCP lifecycle, and
   deterministic non-model boundaries; keep completed agent turns in the
   protected live lane. This removes a production-shipped fake model runtime.
2. **Credential-free completed turn remains mandatory:** explicitly specify the
   static provider-registry entry, worker adapter/runner, and credential contract.
   Either add a provider/adapter-level `none` requirement honored by spawn,
   preflight, required-provider/readiness, and diagnostics, or explicitly set
   global `model_access.enabled: false` in the isolated fixture and accept its
   limitations. Pin worker runtime, memory/classifier behavior, failure modes,
   and tests proving production providers still fail closed.

"Selected only via test desired-state config" is not itself an authorization
boundary. Once shipped in the static provider and adapter registries, any admin
who can write valid desired state can select it. V3 must either define it as a
supported local deterministic provider with honest user-visible semantics or
define an enforceable availability boundary compatible with the exact
`NODE_ENV=production` image. A convention is insufficient.

## 2. Corrected semantic matrices

Verdict: **SAFE** for the six requested semantics. No residual behavioral drift
was found in those rows.

- `ask` does not enter the classifier path; classifier consultation is limited
  to `auto` and `auto_strict` eligible tool requests
  (`apps/core/src/runtime/permission-classifier.ts:242-254`).
- `auto` computes the deterministic read-only gate and still consults the
  allow-leaning classifier (`permission-classifier.ts:281-304,323-347`;
  `permission-classifier.test.ts:539-612`).
- `auto_strict` hard-asks when the gate cannot prove safety, but calls the
  strict classifier for proven input (`permission-classifier.ts:315-341`;
  `permission-classifier.test.ts:614-667`).
- A YOLO denylist match yields `ask`, skips the classifier, and emits
  `permission.yolo_denylist_hit`; a parent context may later convert that ask to
  denial (`permission-classifier.ts:305-365`;
  `permission-classifier.test.ts:868-941`).
- Durable shell suggestions are parsed per command leaf into scoped
  `RunCommand(<argv shape>)` rules, not a command-name class
  (`apps/core/src/application/permissions/permission-suggestion-synthesis.ts:62-89`).
- Persistent authority is an app/agent/tool binding with no conversation key;
  conversation id is audit actor context
  (`apps/core/src/adapters/storage/postgres/schema/tools.ts:50-78`;
  `request-permission-review.test.ts:429-505`).
- `networkHosts` populate attribution, while public hosts remain default-allow
  unless the denylist blocks them (`egress-gateway.test.ts:173-240,492-510`;
  `apps/core/src/runtime/egress-gateway-audit.ts:27-61`).

One execution detail still needs locking: the hermetic `RunCommand` scenario
says "auto/human path." A credential-free hermetic run should use the attended
`ask` path unless v3 also supplies a deterministic credential-free classifier
client. `auto` and proven `auto_strict` invoke a separate classifier LLM; a
deterministic agent execution adapter alone does not make that classifier
credential-free.

## 3. Fixtures and offline execution

Verdict: **NEEDS-RESTAGE**.

The proposed fixture directions are viable:

- `/v1/skills/install` accepts an authenticated local `application/zip` and
  stores its complete asset set (`apps/core/src/control/server/routes/skills.ts:54-119`).
- The existing in-process Streamable HTTP MCP pattern is real and can be
  extended with `get-sum` (`apps/core/test/integration/inline-agent-runtime.integration.test.ts:328-357`).
- The nonexistent `server-everything@2.0.0` dependency is removed, and v2
  correctly bounds "offline" to execution after dependency/image preparation.

The plan is not yet decision-complete:

- It still does not name the authoritative `internal-comms` source URL or lock
  the literal source commit and expected content hash. "Pinned commit" and
  "content hash" are instructions to choose values later, not pinned values.
- The cited MCP pattern binds to host loopback. A server in the host test
  process is not reachable at `127.0.0.1` from the packaged runtime container.
  V2 does not specify whether the fixture runs inside the runtime container, in
  a sibling container, or behind a host-gateway address.
- "Verify via the harness network boundary" does not define the boundary. The
  current egress gateway is default-allow for public hosts, so it cannot prove
  no external network merely from empty `networkHosts`. V3 must specify an
  isolated Docker network/firewall topology that permits Postgres and the MCP
  fixture while denying external routes, plus a negative probe that would fail
  if internet access leaked.

## 4. `gantry-admin` packaging

Verdict: **NOT-SAFE**.

V2's chosen `/v1/skills/install` route cannot install the bundled skill. The
skill service rejects any catalog or declared name that materializes to
`gantry-admin` because it is a reserved Gantry directory
(`apps/core/src/domain/skills/skills.ts:18-24,76-83`;
`apps/core/src/application/skills/skill-service.ts:340-371`). The rejection is
explicitly pinned by `skill-service.test.ts:246-256`.

The current bundled source expects
`<packageRoot>/.agents/skills/gantry-admin/SKILL.md`
(`apps/core/src/adapters/llm/anthropic-claude-agent/claude-skill-materializer.ts:39-68`),
while the runtime image copies neither `.agents` nor that skill
(`ops/docker/Dockerfile:40-52,99-113`).

The minimum correct packaging decision is a narrow image/build artifact copy of
only `.agents/skills/gantry-admin` into the path the bundled source already
owns. Do not weaken the reserved-name guard or route the bundled identity
through the user-installed artifact namespace merely to avoid a Dockerfile
change.

## 5. Image provenance and merge-policy trust

Verdict: **NEEDS-RESTAGE**. The policy semantics are mostly sound; the
operational contract is not locked.

Correct and safe decisions in v2:

- UNKNOWN remains risky.
- `e2e-reviewed` does not downgrade UNKNOWN.
- protected model credentials are excluded from ordinary fork PR execution.
- no `pull_request_target` checkout/execution of PR code is allowed.
- the exact aggregate check must be activated in branch protection/rulesets,
  not merely emitted by a workflow.

Remaining decisions:

- Choose one immutable transfer mechanism. V2 still says Docker artifact **or**
  trusted registry, while later prose assumes an artifact. If artifact is the
  decision, lock `docker save`/upload/download/load, artifact name and
  retention, digest/OCI-id verification, and current head-SHA binding before
  the live job runs.
- A protected workflow must not execute a fork-built image with model secrets
  merely because the workflow file is trusted. Lock the enforceable rule: no
  live secret-bearing execution for forks, or a mandatory protected-environment
  approval after review of the exact head SHA and digest. Reject stale artifacts
  after synchronize events.
- Choose branch protection versus repository ruleset, name the rule/check
  exactly, state the required repository-admin permission and activation step,
  and verify the resulting GitHub state after the write. No repository-local
  ruleset currently exists; saying activation is "in scope" is not an
  executable handoff.

## 6. Budget and Surface Impact Matrix

Verdict: **NEEDS-RESTAGE**.

The budget is not rebaselined. V2 repeats the round-1 instruction to add
per-shard budgets, a cache/artifact strategy, and measured cold/warm baselines,
but provides none of them. The current CI job still has a 30-minute job limit
and 900-second per-command limits (`.github/workflows/ci.yml:19-21,80-106`),
and compose readiness alone permits a 60-second start period plus 30 five-second
retries (`ops/docker/docker-compose.fleet.yml:98-110`). Docker image artifact
upload/download and the expanded serial Postgres lane add new unmeasured time.

The Surface Impact Matrix also violates the plan contract. `Channel/provider
adapters` is classified as "Providers observable; channels deferred," which is
neither one allowed status nor accurate: a new deterministic provider adapter
is **Changed**, while channels are **Deferred** with the stated reason. If v3
adds credential-free provider semantics, model credential readiness/preflight
and provider-registry behavior are Changed surfaces too. The `settings.yaml`
row must say explicitly whether the hermetic fixture sets
`model_access.enabled: false` or relies on a new per-provider credential
contract.

## 7. New problems and over-engineering check

1. The deterministic provider is heavier than v2 acknowledges. An execution
   adapter only prepares a runner process (`agent-execution-adapter.ts:115-167`);
   exact scripted tool use requires a runner that speaks the host runner/IPC
   protocol and actually traverses permission, MCP, skill, and output paths.
2. Shipping a test-labeled provider for "local dev/demo" expands product scope
   and makes a canned response lane admin-selectable unless a real availability
   contract is added. That is not a test-only effect.
3. The plan does not pin worker versus inline for the deterministic lane, even
   though only the worker side has the proposed adapter-registry seam.
4. The goals index still describes the obsolete "everything server" fixture
   (`docs/architecture/goals-index.md:82-85`), so implementation handoff would
   start with contradictory planning docs.

The lighter alternative is still the round-1 split: always require hermetic
packaged boot/config/restart/non-model lifecycle proofs, and use the already
planned protected live lane for completed model-directed turns. If a completed
hermetic turn is a non-negotiable product requirement, v3 must budget and model
the deterministic provider as a real runtime/provider feature rather than a
small test fixture.

## Minimum v3 restage set

1. **Resolve credential-free routing end to end.** Choose the lighter split or
   specify the deterministic provider registry entry, worker runner, credential
   requirement/broker behavior, preflight/readiness/diagnostics behavior,
   classifier behavior, availability boundary, and fail-closed tests. Pin the
   hermetic lane to worker.
2. **Correct bundled-skill packaging.** Package only the reserved
   `.agents/skills/gantry-admin` artifact at its existing bundled path; keep the
   generic install API and reserved-name rejection unchanged.
3. **Seal fixture identity and isolation.** Pin the `internal-comms` URL, literal
   commit, license, expected hash, and checked-in zip; define a Docker-reachable
   echo/get-sum topology and an external-network-denial mechanism with a negative
   probe.
4. **Lock provenance and repository policy mechanics.** Choose the image
   transfer path, bind digest to head SHA, prohibit secret-bearing fork artifact
   execution, and specify/verify the exact GitHub ruleset or branch-protection
   write.
5. **Actually rebaseline and correct the matrix.** Supply measured cold/warm
   baselines, per-shard limits, cache/artifact timing policy, a timeout with
   headroom, valid Surface Impact Matrix statuses, and cleanup of the stale
   goals-index fixture description.

## Overall decision

**NOT APPROVED FOR IMPLEMENTATION.** V2 fixes the semantic matrices but does
not make the always-required credential-free completed turn feasible under the
current default gateway, chooses an impossible `gantry-admin` install route,
and leaves the offline topology, immutable handoff, branch-protection operation,
and timing budget short of decision-complete. The five-item v3 restage set above
is the minimum required before implementation.
