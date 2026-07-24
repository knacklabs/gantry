# Agent E2E CI Merge Gate — goal prompt

Status: RESTAGED v3 (2026-07-20) after plan-validation rounds 1 and 2. Round 2
marked the permission/capability semantic matrices SAFE but kept the
deterministic-model-boundary NOT-SAFE (a registered adapter can't bypass the
credential gateway). v3 DROPS the deterministic provider entirely (user
decision): the gate runs a real low-spend model (haiku) with user-supplied
credentials and BEHAVIORAL assertions. Round-3 validation required before
implementation.

**Hard exclusion:** `i-have-adhd` is a conversation-only communication skill.
NEVER copied/installed/inspected/fixtured/asserted by any E2E test. A guard test
(scoped to E2E-owned fixture/manifest/prompt/snapshot/assertion surfaces only,
constructing the forbidden token from fragments so it doesn't self-match)
enforces zero references. It is untracked local content, absent from the image
(Dockerfile doesn't copy it) and from skill discovery roots — no runtime path
picks it up.

## Why
Releases are risky without real-world testing. Unit/integration tests pass but
the composed packaged runtime (real image → real agent turn → skill/MCP/
permission/capability → audit) is unproven per-PR. This session's incidents
(route corruption, render sandbox, permission flood, silent audit loss) slipped
through because nothing exercised the packaged runtime end to end.

## Model boundary — RESOLVED (v3): real model + behavioral assertions
Round 2 proved a deterministic adapter CANNOT bypass the credential gateway by
registration alone — the host projects credentials and the gateway throws before
the adapter's `prepare()` runs (broker defaults `gantry`;
`default-runtime-adapters.ts:34-43`, `gantry-model-gateway.ts:135-154`). Rather
than build a credential-free route, the gate uses the PRODUCTION path with a real
model:
1. **The gate runs a real low-spend model (`haiku`, anthropic_sdk) via the normal
   gantry gateway**, credentials supplied by CI (protected-environment secret,
   user-provided, NOT production). No new adapter, no runtime change, no
   credential-free route — the exact production model path is exercised.
2. **Assertions are BEHAVIORAL, robust to phrasing** — NOT exact output text.
   Assert: the turn reached completion; the expected skill/MCP/tool was invoked
   (from tool traces + audit events + persisted records); the permission decision
   fired on the right path; the capability preflight passed/failed-closed; the
   status was delivered. Do NOT assert exact reply strings, exact `get-sum=42` in
   the reply text, or an exact 3P-format body — assert the tool was CALLED with
   the right args and the structured record exists. (Same shape as the existing
   KnackLabs CLI smoke: it asserts `health == completed`, not reply text.)
3. **Not fully offline** — the gate needs model-API credentials + egress to the
   model host. Fixtures (skills, MCP) stay LOCAL/vendored; the "no external
   network" rule narrows to: no npm/git/registry/fixture fetches during test
   execution; the model API is the only permitted external call.
4. **Broader model coverage stays label-gated.** The always-required gate runs
   `haiku` only; `gpt-mini`/deepagents and the base/head catalog diff run on
   risky (`live-agent-e2e`-labeled) PRs. All model creds are protected-environment,
   never exposed to fork-PR code.
- NO runtime/image surface change from a test provider (that idea is dropped).
  Surface matrix Runtime row reverts to Read-only/observable.

## Current CI runner boundary (decision 0044)

All current workflow jobs run on GitHub-hosted ephemeral `ubuntu-latest`
runners, including the pull-request agent E2E lane. The real-model step keeps
its `E2E_MODEL_API_KEY` mapping step-local and exits successfully before model
invocation when that secret is absent, which is the expected fork-PR path.
Workflow-level token permissions default to `contents: read`; jobs that publish
branches, packages, issues, or labels add only their required write scopes.
`scripts/check_ci_runner_isolation.py` enforces these invariants.

## What already exists (dedup — do NOT rebuild)
Deep unit + integration coverage exists for permission/capability LOGIC. THE GAP:
(a) `test:integration:postgres` is NOT in CI (gates nothing today), and (b)
nothing proves the pieces composed in a real packaged runtime turn. v2 WIRES +
composes + fills boundary gaps; it does not rebuild covered logic. Each already-
covered matrix row cites its existing test and adds only the rightmost gap.

## CI reality corrections (validation §1)
- CI builds the image (`docker compose build --pull`, local tag
  `gantry-runtime:fleet-rehearsal`) but never starts it, and runs test:e2e +
  test:e2e:postgres but NOT test:integration:postgres (`.github/workflows/ci.yml`).
- `test:integration:postgres` runs a hard-coded 19-file list that OMITS
  `fleet-capability-chaos-combo.postgres.integration.test.ts`,
  `fleet-capability-state-repositories.postgres.integration.test.ts`, and
  `domain-repositories.postgres.integration.test.ts` (capability-secret + binding
  persistence). v2 EXTENDS that list to include the capability persistence suites
  the gate must cover. (chaos-combo is concurrency/convergence + slow → put it in
  its own shard, not the 15-min-critical path.)
- The Postgres harness needs a live disposable DB (unique schema + full migrations
  per runtime) — a real dependency, not a skipped unit lane. It needs no model
  credential.
- **Image provenance:** CI must hand the EXACT built image to the E2E job via an
  immutable artifact (`docker save` → upload → download → load) or a content-
  addressed PR image in a trusted registry — never a rebuild. Record the digest
  in evidence.
- **Image packaging:** the image omits `.agents` (Dockerfile copies only
  packages/apps/dist/deps), so the bundled `gantry-admin` skill isn't present.
  v2 decision: install gantry-admin via the authenticated `/v1/skills/install`
  zip path in-scenario (no Dockerfile change), OR add `.agents/skills` to the
  image — pick the install-via-API path (smaller blast radius).

## Granular PERMISSION matrix — CORRECTED to current semantics (validation §3)
Cite the existing test for each proven row; add only the rightmost boundary gap.
- `ask` (default): eligible tools prompt human; nothing auto-decided.
- `auto`: evaluates the deterministic read-only gate as EVIDENCE, then consults
  the allow-leaning classifier (NOT "no gate") — `permission-classifier.ts:295-341`.
- `auto_strict`: asks WITHOUT classifier only when deterministic safety is
  unproven; deterministic-PROVEN input still calls the strict classifier (does NOT
  auto-allow from the gate alone) — classifier.test.ts:614-667.
- YOLO denylist hit → returns `ask` + emits `permission.yolo_denylist_hit`; an
  unattended/locked parent flow may CONVERT that ask to denial (name the context;
  it's not universally "blocked") — classifier.test.ts:868-941.
- Durable authority = `RunCommand(...)` ARGV-LEAF scope (NOT a command-name class;
  command-name class is the separate permission-lane's future change). Each simple
  command leaf matches its own rule — permission-suggestion-synthesis.test.ts,
  runner/AGENTS.md:34-40.
- Persistent rules = AGENT tool bindings; `conversationId` is in the audit ACTOR
  context, NOT the binding identity → a rule is isolated from another AGENT but
  NOT from another conversation on the same agent. Test CURRENT agent-wide
  semantics (conversation-scope is the permission-lane's future authorization
  change) — request-permission-review.test.ts:429-505.
- Locked-agent forged IPC → fail-closed at parent boundary —
  ipc-locked-permission-denial.test.ts.
- Eligibility → only Bash/RunCommand + non-gantry MCP reach the classifier.
Remaining integration GAPS to add (the only new work): one real chain through the
parent callback/IPC boundary → durable interaction → decision → event repository;
attended-vs-unattended context proof; promotion RESTART SURVIVAL + record-before-
prompt ordering (the Postgres promotion test only covers counters today); whole-
chain audit/log credential-absence.

## Granular CAPABILITY matrix — CORRECTED (validation §4)
- Declaration → `capability:<id>` + scoped `RunCommand(...)` rule projection —
  configured-agent-tools.test.ts (covered); GAP = persisted selected binding
  through projection + real admission.
- local_cli contract (pinned path/version/hash, narrow templates, deny unrelated)
  — semantic-capabilities.test.ts (covered); GAP = real-image executable
  inventory/preflight pass AND fail-closed chain.
- Sandbox/credential — protected-path + fail-closed integrity covered in units;
  GAP = selected capability through sandbox materialization + unavailable-
  credential behavior with NO plaintext leak.
- Persistence — store/replace covered; GAP = explicit store→retrieve→rotate→audit
  lifecycle (no current test proves all four).
- **Egress correction:** `networkHosts` is reviewed capability ATTRIBUTION, NOT an
  allowlist. Current gateway = DEFAULT-ALLOW for public hosts (undeclared public
  hosts allowed even with capability hosts present) — egress-gateway.test.ts:173-225.
  Test the CURRENT contract (denylist blocks + `egress.connect` attribution), not
  an allowlist.

## API for EVERYTHING (v3, user directive)
Every setup, configuration, and interaction step in the gate goes through the
Control API / SDK against the disposable test Postgres — NEVER hand-written DB
rows, settings files, or CLI-only paths. This makes the gate a full API contract
test in the same pass: agent onboarding, conversation binding, model
selection/routing, skill install + selection, MCP registration + approval,
capability grant, permission decisions, and the agent turn are ALL driven by API
calls. For each step assert BOTH the API contract (status code, response shape)
AND the persisted/runtime effect (settings revision appended, Postgres
projection, post-restart survival, the turn's actual behavior). Reuse existing
endpoints; no production-only test routes. **Any operation lacking an API gets
the API IMPLEMENTED as part of this lane** (user directive 2026-07-20) — a
first-class, reviewed, documented endpoint (contracts-first if it needs a public
DTO, honoring the ponytail Phase-4 collision rules), not a test-only backdoor.
The gate then consumes the new API like any client. CLI/desired-state
workarounds are not acceptable substitutes.
- **Onboarding via API:** create agent + binding via the supported endpoints;
  assert contract + persisted revision + post-restart survival.
- **Model selection via API:** select the `haiku` alias / default slot / per-agent
  override via the model-management API; assert the response AND that the turn
  routes to the selected model (evidence alias/route/provider/harness matches) —
  catches model-API contract drift.

## Channel loop via a dedicated test Slack app (v3, user offer — label-gated)
A dedicated Slack app + test workspace lets the gate test the FULL channel loop,
not just the Control API turn: inbound Slack message → agent turn → outbound
Slack delivery, plus the interactive permission-approval block rendering + the
approve/deny callback path. This upgrades the previously-deferred channel row.
Constraints:
- **Label-gated, NOT the always-required gate.** Slack API availability, rate
  limits, and socket-mode connect time make it too flaky to block every routine
  PR. It runs on `live-agent-e2e`-labeled (risky) PRs alongside the model matrix,
  or on a schedule — never gating a docs/typo PR.
- Credentials (bot/app tokens) = protected-environment secrets, never exposed to
  fork-PR code, same trust boundary as model creds.
- Scenario: post a message to a dedicated test channel via the Slack API → assert
  the agent's outbound reply lands in-channel (message + any attachment) → trigger
  a permission-requiring tool → assert the approval BLOCK renders (Slack
  header/context blocks) → drive the approve callback via the Slack API → assert
  the tool proceeds + audit records the decision. Behavioral (assert the delivered
  block structure + callback effect), not exact copy.
- Isolated: a dedicated app/workspace/channel so runs never touch real user
  conversations; each run uses a fresh thread and cleans up.

## Agent exercises ALL its tools (v3, user directive)
The real-model turn must prove the agent can actually USE every tool available to
it, not just one. After onboarding + granting the full tool set via API (skills,
MCP tools, gantry tools, capabilities, RunCommand rules, WebSearch/WebRead,
Browser), drive the agent (via directive prompts, one tool-family per step or a
scripted multi-tool task) so it invokes EACH available tool at least once, and
assert per tool: the tool was CALLED (tool trace + audit event), it returned its
expected structured effect, and no granted tool silently failed to be reachable.
The gate FAILS if any granted tool is unreachable/never-invocable in the composed
runtime. This is the comprehensive "the agent can use all its tools" proof —
behavioral (assert the call + effect), not exact reply text. Enumerate the
agent's effective tool set from the API (its granted/effective tools) so the
exercise stays in sync as tools are added.

## External dependency tiers (v3, grill)
The all-tools exercise can't call every real backend without flaking. Tier it:
- **REAL (gate-owned test accounts, protected-environment secrets):** the model
  (`haiku`), the dedicated test Slack app, and ONE throwaway Google Sheet for the
  `gog`/sheets capability. These prove real integrations end to end — the exact
  class the KnackLabs job needed (gog auth + real Sheets write).
- **STUB (loopback):** every other external tool — arbitrary capabilities,
  third-party MCP — hits a loopback stub that asserts the CALL shape + args (proves
  the agent can INVOKE the tool), not the remote effect. Keeps the gate reliable.
- **Browser:** exercise against a loopback static page (real Chrome via the host
  browser capability, no external web) — proves the browser tool path without
  external-web flakiness.
A tool is "exercised" if it was invoked with correct args and its
result/stub-response + audit recorded; only the REAL tier also asserts the remote
effect.

## Fresh onboarding per run (v3, grill)
Every gate run creates a NEW agent + conversation binding + tool/capability grants
via API against the disposable DB, then tears down. This proves the onboarding +
model-selection + grant APIs actually work (the API-for-everything directive) and
catches setup-path regressions — the failure class behind this session's
incidents. Fully isolated; the small extra per-run time is accepted.

## Isolation guarantee (v3.1, user directive — HARD contract)
The gate NEVER touches the live local runtime. Every run builds a runtime home
FROM SCRATCH and destroys it:
- `GANTRY_HOME` = a fresh temp dir per run (mktemp-style), never `~/gantry`.
  The harness REFUSES to start (hard assert) if the resolved GANTRY_HOME is the
  user's real runtime home or if the database URL matches the live `gantry` DB.
- Fresh disposable Postgres per run (CI service container / local throwaway
  database or unique schema), migrated from zero. Never the live DB.
- All runtime secrets (SECRET_ENCRYPTION_KEY, GANTRY_IPC_AUTH_SECRET, control
  API keys) generated fresh per run — never read from `~/gantry/.env`.
- Input secrets (E2E_ANTHROPIC_API_KEY, label-gated Slack/Google) come from a
  gitignored `<repo>/.env.e2e` locally or protected-environment secrets in CI —
  NOT from any file under `~/gantry`.
- Full teardown after the run (temp home removed, DB dropped). A failed run
  leaves its evidence bundle, not a half-alive runtime.
- (Distinct by design: `scripts/agent-job-smoke.sh` deliberately targets the
  LIVE runtime for the user-approved KnackLabs live smoke; the CI gate does not.)

## Fixture kit (v3.1 — complete inventory)
Beyond the MCP test server, the gate needs these test doubles/fixtures:
- **Attachment fixture:** a small file the agent must SEND during a turn; assert
  outbound delivery via the #234 workspace-direct path (regression: file-send
  broke in the 2026-07-20 incident with zero coverage).
- **Loopback webhook receiver:** asserts job/event webhook delivery fires with
  the expected payload shape.
- **Egress fixture pair:** one denylisted hostname + one allowed loopback host;
  assert denylist block + `egress.connect` attribution records.
- **Delegation target agent:** a second minimal agent so `AgentDelegation` is
  exercisable in the all-tools sweep.
- **Always-failing job fixture:** deterministically drives retry → dead-letter.
- **Deep-MCP scenario (user, 2026-07-20 — label-gated):** a VENDORED, real
  published version of `@modelcontextprotocol/server-everything` (exact version
  pinned by content hash, full dependency closure vendored — no test-time
  install; runs beside the harness in the correct network namespace).
  Rationale: gantry is an MCP CLIENT PLATFORM — if it mishandles any MCP
  capability class a compliant server offers (tools, resources, prompts,
  sampling, progress, logging, completions), that is a PRODUCT BUG, not a test
  limitation. The scenario walks every capability class the server advertises;
  for each: either gantry handles it correctly (asserted behaviorally) or the
  gate FAILS with a per-capability finding. A deliberate non-support decision
  must be recorded explicitly in docs (fail-honest), not discovered by users.
  The in-process echo/get-sum fixture remains the required-gate MCP test
  (fast, recorded); deep-MCP runs on the label-gated lane.
- **Inline-lane turn:** one cheap haiku call through the inline runtime / LLM API
  lane (the second execution path) so both lanes are proven, not just the worker.
- stdio-MCP transport stays at the integration layer (existing `ipc-mcp-stdio`
  coverage); the E2E MCP fixture tests Streamable HTTP.

## Memory coverage (v3.1, user directive — was missing)
- Integration (deterministic, test Postgres): memory write → recall → subject
  BOUNDARY scoping (person/group/channel isolation — a memory stored for one
  subject is not recalled for another); retention/dedup behavior as implemented.
- E2E behavioral (part of the haiku turn): turn 1 states a distinctive fact via
  API → assert a durable memory record was collected (persisted row + audit, not
  phrasing); turn 2 asks for it → assert the memory READ occurred and the reply
  is consistent with recall (behavioral). Post-restart: the memory survives and
  is still recallable.
- Job-run memory: after the scheduled-job scenario completes, assert the
  "collected durable memory after successful job run" path persisted its record.

## Jobs lifecycle coverage (v3.1, user directive — expanded)
- E2E (real turn): create a job via API → trigger → the run completes → delivery
  recorded → job health `completed` (the API twin of scripts/agent-job-smoke.sh).
- Lifecycle via API: pause → resume → trigger; assert state transitions +
  events. Forced-failure path: a job that always fails exhausts retries →
  dead-letter state + a clean terminal event (no zombie).
- Autonomous dead-end regression (below) covers the ungranted-tool case.

## Regression scenarios — this session's incidents codified (v3, grill)
Named permanent guards so the failures that motivated this gate can't silently
return (each maps to a fix landed/landing this session):
- **MCP-readiness race:** a job starting under slow SDK init must NOT hard-fail —
  transient `pending`/`connecting` tolerated, only terminal `failed`/`needs-auth`/
  `disabled` fails (fix: `mcp-server-validation.ts` terminal-status set).
- **Route-loader corruption:** divergent-`conversationId` rows must still load —
  derive-canonical-on-read (no throw), dedup keeps the qualified route (fix:
  `canonical-binding-ops-service.ts` dedup + `bindingRowToGroup` derive).
- **Autonomous tool dead-end:** a scheduled job needing an ungranted tool surfaces
  cleanly (setup-required / clear terminal outcome), not a mid-run death on an
  unanswerable permission prompt.
- **Permission-receipt silence:** allow-for-future posts NO chat receipt (matches
  allow-once) (fix: `ipc-interaction-processing.ts`).
Most can run at the integration layer (fast, deterministic); the MCP-race one
needs the packaged real-turn path.

## Packaged-runtime E2E proofs (thin, real image + real haiku turn)
Typed `AgentE2EScenario` + `AgentE2EEvidence` under `apps/core/test/agent-e2e/`.
Start the EXACT CI-built image (immutable artifact) with isolated `GANTRY_HOME`,
disposable Postgres, real migrations, isolated non-production encryption/IPC
secrets, an enforcing `sandbox_runtime` config (the production image sets
NODE_ENV=production → security posture requires enforcing sandbox + non-prod
secrets independent of model access — `security-posture.ts:31-80`), restart once,
then drive onboarding + model selection via API (above), then a real Control API
turn: `POST /v1/sessions/ensure` (sessions:write) → `POST
/v1/sessions/{id}/messages` (returns 202 — NOT completion) → observe events via
sessions:read until visible completion. A 202 is NOT a completed turn. The turn
runs on real `haiku`; assertions are behavioral (tool traces / audit / persisted
records), not exact reply text.
Evidence: scenario, image digest, model alias/route, provider, harness, run/
session IDs, selected skills, MCP calls, capability decisions, audit IDs, timings,
redacted failure detail.
Scenarios (BEHAVIORAL assertions on a real `haiku` turn — tool traces / audit /
persisted records / structured records, NOT exact reply text; steer the turn with
a directive prompt so the model reliably invokes the target tool, and assert the
tool CALL + its structured effect, not the phrasing):
| Scenario | Proof |
|---|---|
| Onboarding+model API | Agent + binding created via Control API/SDK; model selected via model-management API; assert API contract (status/shape) + persisted revision + post-restart survival + the turn routes to the selected `haiku` alias. |
| Runtime/model | Image starts, migrations current, turn completes; evidence identifies alias/route/provider/family/harness. |
| Skill lifecycle | `internal-comms` (vendored subtree + license + provenance + content hash, pinned commit) installs via `/v1/skills/install` zip, binds, survives restart, materializes the planned 3P updates example asset; assert the skill was SELECTED + its files materialized + (behaviorally) the model produced the Progress/Plans/Problems STRUCTURE — assert the structural sections exist, not exact wording. `gantry-admin` is NOT installed (reserved name — `/v1/skills/install` rejects it); instead assert its already-bundled read-only tool `admin_permission_list` is callable and returns the expected shape. |
| MCP lifecycle | In-process Streamable HTTP test server (extend the existing `inline-agent-runtime.integration.test.ts:328-357` pattern) exposing `echo` + `get-sum` — do NOT depend on `@modelcontextprotocol/server-everything@2.0.0` (does not exist; E404). Only echo+get-sum approved; discovery, schema, denied-tool invisibility, MCP audit; assert the model CALLED `get-sum(20,22)` and the tool returned `42` (assert the tool result + audit, not that `42` appears in the reply text). |
| Permission real-turn | A directive prompt makes the model issue a RunCommand; assert it's permission-decided on the current auto/human path + audit recorded. |
| Capability real-turn | `admin_permission_list` succeeds; a local_cli capability preflight passes / fails-closed in the real image. |
| Recovery/security | Skill+MCP selections survive restart; transient authority (allow_once) does NOT; logs/evidence credential-scrubbed. |
Scripts: `test:e2e:agent:policy`, `test:e2e:agent:hermetic`, `test:e2e:agent:live`;
wire (extended) `test:integration:postgres` into CI.

## Fixtures — offline & valid (validation §5)
- Vendor the pinned `internal-comms` subtree + examples + license + source commit
  + content hash; build a deterministic checked-in zip for `/v1/skills/install`.
- MCP: use a vendored in-process Streamable HTTP server (echo+get-sum), NOT the
  nonexistent server-everything@2.0.0.
- Prohibit git fetch / npm install / npx / registry access during the hermetic
  test EXECUTION phase (the image also strips npm/npx); verify via the harness
  network boundary. "No internet" = no external network during test execution
  (after dep/image prep), not the whole job.

## Live model matrix (label-gated; user-supplied credentials)
| Alias | Harness | Proof |
|---|---|---|
| `haiku` | `anthropic_sdk` | Agent response, selected skill, Gantry tool, audit evidence |
| `gpt-mini` | `deepagents` | Agent response, selected skill, MCP proxy call, audit evidence |
Semantic base/head catalog diff (EXECUTABLE contract: inputs = base+head model
catalogs; output schema = {alias, change: added|route-changed|cred-changed|
family-changed|removed}; deleted/renamed classified explicitly) adds new/changed
aliases. Missing credentials FAIL (not skip) on the live lane ONLY. Credentials =
dedicated low-spend protected-environment secrets (user-provided), never
production.

## Merge policy — trust boundary sealed (validation §7)
Add the planned agent E2E workflow, triggered on PR open/synchronize/reopen/label/unlabel.
- The required gate (real `haiku` agent turn + all-tools exercise, API-driven) +
  (extended) test:integration:postgres run for every non-docs PR. It needs the
  model credential on same-repo PRs. Fork PRs receive no model secret, so the
  real-model step exits successfully without model invocation while the
  credential-free checks still run.
- Path-map (checked-in globs → risk area) classifies changed paths. UNKNOWN stays
  RISKY for live-gate purposes until the path-map is updated; `e2e-reviewed` may
  ACKNOWLEDGE a mapping miss but MUST NOT silently downgrade unknown code to
  non-risky.
- Risky PRs fail until `live-agent-e2e`; the label starts the protected-environment
  extended-model job (gpt-mini/deepagents + catalog diff) against the immutable
  prebuilt image artifact (same digest, never a rebuild).
- **Fork-secret safety:** model secrets are absent from untrusted fork PRs and
  the real-model step carries an explicit absent-secret skip guard. Same-repository
  PRs keep the full real-model merge check. NO `pull_request_target` checkout of
  PR code.
- `agent-e2e-gate` aggregates all results. Branch-protection/ruleset activation +
  verification of the exact required check name is IN SCOPE (a workflow check is
  not a required gate by itself).

## Failure & evidence policy
- Deterministic (non-model) failures NOT retried. Model-transient failures
  (429/5xx/timeout/transport) retried ONCE; a retry-pass = `FLAKY` and STILL
  blocks merge (so real regressions can't hide behind flakiness).
- Success AND failure upload redacted JSON evidence + audit/event extracts +
  container logs + timings + targeted rerun command.

## Budget — rebaselined (validation §8)
15 min is a TARGET, not a validated criterion. Restage with: per-shard wall-clock
budgets, a Docker layer-cache/artifact strategy, and MEASURED cold + warm
baselines. If the cold required gate can't reliably finish under 15 min with
headroom, RAISE the timeout rather than make a flaky performance promise. (Current
CI allows 30 min / 900s per command.)

## Sharding mechanics (adopted from Hermes CI, 2026-07-20 research)
Concrete mechanism for the per-shard budgets: cache per-file test DURATIONS as
a CI artifact (updated only on main-branch success), generate balanced slices
via longest-processing-time distribution, run slices as a matrix. Per-slice
timeout 30 min; duration-cache upload `continue-on-error` so a transient
upload failure never fails the gate. Deterministic lanes run with model
credential env vars EXPLICITLY CLEARED (Hermes pattern) so nothing
accidentally goes live; only the gate's turn job receives
`E2E_ANTHROPIC_API_KEY`. Live lanes: `*.live.test.ts` naming + per-provider
concurrency caps (OpenClaw pattern).

## Budget — real-model turn factored in
The gate now runs a real `haiku` turn (plus image boot + migrations + restart +
the all-tools exercise), so it is NOT credential-free and the turn adds real
model latency. 15 min is a TARGET, not a promise: shard the work (integration-
postgres shard, agent-turn+all-tools shard, policy shard), use a Docker layer-
cache/immutable-artifact strategy, and MEASURE cold + warm baselines. If the cold
required gate can't finish under 15 min with headroom, RAISE the timeout rather
than make a flaky performance promise. (Current CI allows 30 min / 900s per
command.)

## Surface Impact Matrix (v3)
| Surface | Classification | Reason |
|---|---|---|
| Runtime behavior | Read-only/observable | Exact production image + real `haiku` model path exercised; NO test provider in the image (deterministic-provider idea dropped). |
| `settings.yaml` | Read-only/observable | API-driven desired-state ops; verify synchronized output. |
| Postgres/runtime projection | Read-only/observable | Disposable rows verify revisions, bindings, restart projection, transient expiry. |
| Control API + model-management API | Gate target (contract-tested) | Onboarding, model selection, skill/MCP/capability/permission all driven via API and asserted for contract + effect. Existing endpoints; no new routes. |
| SDK/contracts | Unchanged by design | Existing clients reused; new types test-internal. |
| CLI | Unchanged by design | Gate is API-driven; CLI unchanged. |
| Gantry MCP/admin tools | Read-only/observable | `admin_permission_list` exercised (gantry-admin NOT installed — reserved name). |
| Channel/provider adapters | Providers observable; Slack channel loop label-gated | Model harness(es) tested every PR; the full Slack inbound→turn→outbound + approval-block loop runs on labeled PRs via a dedicated test Slack app. |
| CI workflow / GitHub ruleset | Changed | New workflow, path-map, aggregator, branch-protection activation; model-credential protected-environment secret. |
| Image provenance | Changed | Immutable artifact handoff bound to head SHA (`docker save`→upload→download→load). No image content change. |
| Docs/prompts | Changed | This goal prompt + CI/scenario/evidence docs. |
| Audit/events | Read-only/observable | Existing events become assertions/evidence. |
| Tests/verification | Changed | Runner, fixtures, packaged harness, all-tools exercise, granular integration additions, live matrix, policy classifier, aggregator, i-have-adhd guard. |
| Deployment workflows | Deferred | Deploy automation + real TG/Slack canaries excluded; pre-merge CI in scope. |

## Acceptance criteria
- All existing suites green. Extended `test:integration:postgres` (incl. the
  fleet-capability + domain-repositories suites) runs in CI and gates.
- The agent E2E gate completes a REAL `haiku` turn, everything driven via API, and
  proves the agent can invoke EVERY tool in its effective set (behavioral
  assertions).
- Onboarding + model-selection APIs are contract-tested (status/shape) AND their
  persisted/runtime effect verified.
- Granular permission (every current-semantics mode+path) and capability (every
  lifecycle stage) pass at the integration layer, each citing existing coverage +
  its added gap.
- Risky PRs can't merge without `live-agent-e2e` + passing extended model matrix;
  UNKNOWN path changes stay risky; fork PRs never see protected secrets.
- `agent-e2e-gate` is the verified required branch-protection check.
- `i-have-adhd` zero references in E2E surfaces (scoped guard).

## Non-goals
- Deploy automation; real Telegram/Slack canaries. Production credentials in CI.
- Rebuilding granular logic already unit/integration-tested.
- A deterministic/canned model provider or a credential-free model route (dropped
  — the gate uses a real low-spend model).
- Testing not-yet-built behavior (command-name promotion, conversation-scoped
  grants, auto_strict gate-bypass) — those get coverage when the permission lane
  ships them.

## Round-3 outcome → v4 restage plan (2026-07-20)
Round 3 (`agent-e2e-plan-validation-round3.md`): NOT APPROVED, but the model
boundary is now FEASIBLE (round-2 blocker resolved; needs launch-posture
pinning). The remaining work splits into:

### API gaps — RE-ADJUDICATED (user directive: NO test-only APIs)
Rule: an API is built ONLY if it's justified as product surface on its own; the
gate never gets an endpoint the product wouldn't want. Round-3's six gaps recut:
1. **Session targets the onboarded agent — KEEP (it's a BUG FIX, not a new
   API).** `sessions/ensure` accepts `agentId` and silently drops it — any SDK
   user talking to "their agent" is actually getting a synthetic folder. Fix the
   existing route to honor its own contract. Sequence after ponytail Phase 4.
2. **Permission decision API — DROPPED (user, 2026-07-20).** Permission
   decisions belong to the human approver (channel buttons) or the
   auto-classifier; agents only REQUEST. A decide-via-API endpoint would create
   a new authority surface (key holder approves anything, bypassing the
   conversation-bound approver). Testing instead drives the REAL paths:
   auto-classifier decisions at the integration layer; the channel interaction
   callback (the actual button-resolution path) invoked in-process at the
   integration layer; the real Slack button in the label-gated channel loop.
3. **Conversation creation — NOT a new API.** The desired-state/settings import
   surface already creates conversations + installs; the gate drives that
   existing surface. If a true gap is proven during implementation, it returns
   as a product proposal, not a gate workaround.
4. **Per-agent model mutation — DEFERRED to the model-management lane.** That
   finalized goal owns model-selection APIs as product. Until it ships, the
   gate sets the model through the existing desired-state surface.
5. **Semantic-capability registration — NOT an API.** Capabilities are
   settings-defined BY DESIGN (settings as source of truth); the gate registers
   its stub capability through the existing settings/desired-state surface.
6. **Effective-tool enumeration — internal inspector, not a public API (for
   now).** The all-tools sweep enumerates from the runtime's own effective-tool
   computation via test code. If product debuggability wants it exposed later
   ("what can my agent actually do"), that ships via contracts-first as its own
   decision.
Net: ONE bug fix, zero new endpoints. Everything else uses surfaces that exist.

**Testing ladder (user, 2026-07-20):** (1) drive the PUBLIC API where one
exists; (2) where none exists and none is product-justified, test the SERVICE
layer underneath in-process at the integration layer (real service + test
Postgres, no HTTP); (3) NEVER invent an endpoint for testing. Service-layer
tests still assert the same three layers (contract of the service call,
persisted effect, runtime behavior).

### Corrections to fold into v4 (mechanical)
- **All-tools sweep scoping:** classify the effective set into invocation
  classes (read-only / side-effecting-fixture-backed / authority-lifecycle);
  the sweep exercises the first two; authority/lifecycle tools are covered by
  their own scenarios, not blind invocation.
- **Fixture topology:** the packaged runtime runs in a container — loopback
  fixtures on the host are unreachable. Pin: fixtures run in-container beside
  the runtime (or the harness runs on the host network with the container) —
  choose one topology and specify it.
- **Image reality:** Chrome and `gog` are NOT in the packaged image. Re-tier:
  the gog/Sheets real-tier + Browser exercises run in the LOCAL (host) smoke
  variant; the CI container gate covers them via stub capabilities until the
  image ships those binaries (media-render lane owns Chrome provisioning).
- **Slack loop constraint:** gantry ignores bot-authored inbound messages and a
  bot cannot fake a human button click. The Slack scenario needs a real-user
  test message pattern or a separately-reviewed signed-callback fixture —
  re-scope in v4 (possibly manual-assisted, not fully automated).
- **Regression scenarios:** the MCP-race fix is NOW on main (`c6d175057`);
  route-loader + receipt fixes land from their lanes. The branch rebases on
  main before implementing those scenarios; the route-corruption seed uses
  direct test-DB row insertion (documented exception to API-for-everything —
  corrupt states are not creatable via APIs by design).
- gantry-admin prose cleanup (scenario already correct); image-artifact
  head-SHA verification + stale-artifact rejection + fork-execution contract;
  budget: pin initial shard timeouts (raise-not-flake rule stays).

## Validation history
- Round 1: NOT APPROVED — no credential-free completed turn + matrix drift +
  fixture/provenance/merge-policy/budget gaps. `agent-e2e-plan-validation.md`.
- Round 2: NOT APPROVED — matrices SAFE, but deterministic adapter can't bypass
  the credential gateway; gantry-admin reserved-name; provenance/budget open.
  `agent-e2e-plan-validation-round2.md`.
- v3 (this): DROPS the deterministic provider — real `haiku` + behavioral
  assertions; API-for-everything + all-tools exercise (user directives);
  gantry-admin via tool not install; provenance bound to head SHA; budget
  sharded. Round-3 validation REQUIRED before implementation.
