# Agent E2E CI Merge Gate — goal prompt

Status: RESTAGED v2 (2026-07-20) after plan-validation round 1 returned NOT
APPROVED. v2 resolves the model-boundary blocker (deterministic provider +
user-supplied live credentials) and all 5 minimum-restage items. Round-2
validation gate required before implementation.

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

## Model boundary — RESOLVED (v2)
Validation confirmed: NO agent turn completes today without a Gantry Model
Gateway credential (broker defaults `gantry`; both Anthropic + DeepAgents lanes
reject credential-free/non-Gantry projection; the packaged registry has only the
two production adapters — `default-runtime-adapters.ts:34-43`). Resolution:
1. **Deterministic test model provider (NEW) drives the always-required hermetic
   gate.** A packaged-compatible canned/record-replay adapter registered in the
   runtime adapter registry, SELECTED ONLY via test desired-state config (a model
   alias routed to it) — NOT via any production-only test route. It returns
   scripted tool-call sequences + text, needs no external credential or internet,
   and produces EXACT tool traces so assertions are stable. Its authority is
   constrained to the same tool-permission path as any model (no bypass). This is
   the pattern the plan's cited OpenClaw deterministic lane uses; it is also
   reusable for local dev/demo and other lanes' tests.
2. **User-supplied real credentials drive the label-gated live lane.** Dedicated
   low-spend protected-environment credentials (NOT production) power the real
   haiku/gpt-mini matrix. Never exposed to fork-PR code (see merge-policy trust
   boundary). So the always-on gate proves a real composed turn deterministically
   AND real models are proven on labeled PRs.
- Runtime surface change: the deterministic provider is part of the exact
  packaged image (test-config-gated). Surface matrix marks Runtime = Changed.

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
  `fleet-capability-state-repositories.integration.test.ts`, and
  `postgres-domain-repositories.integration.test.ts` (capability-secret + binding
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

## Packaged-runtime E2E proofs (thin, real image + real turn via deterministic provider)
Typed `AgentE2EScenario` + `AgentE2EEvidence` under `apps/core/test/agent-e2e/`.
Start the EXACT CI-built image (immutable artifact) with isolated `GANTRY_HOME`,
disposable Postgres, real migrations, isolated non-production encryption/IPC
secrets, an enforcing `sandbox_runtime` config (the production image sets
NODE_ENV=production → security posture requires enforcing sandbox + non-prod
secrets independent of model access — `security-posture.ts:31-80`), restart once,
then a real Control API turn: `POST /v1/sessions/ensure` (sessions:write) →
`POST /v1/sessions/{id}/messages` (returns 202 — NOT completion) → observe events
via sessions:read until visible completion. A 202 is NOT a completed turn.
Evidence: scenario, image digest, model alias/route, provider, harness, run/
session IDs, selected skills, MCP calls, capability decisions, audit IDs, timings,
redacted failure detail.
Scenarios (behavioral assertions — state transitions/tool traces/persisted
records/structured formats, NOT NL snapshots), all driven by the deterministic
provider so tool selection is exact:
| Scenario | Proof |
|---|---|
| Runtime/model | Image starts, migrations current, turn completes; evidence identifies alias/route/provider/family/harness. |
| Skill lifecycle | `internal-comms` (vendored subtree + license + provenance + content hash, pinned commit) installs via `/v1/skills/install` zip, binds, survives restart, materializes assets incl. `examples/3p-updates.md` via progressive disclosure, produces the pinned Progress/Plans/Problems format (deterministic provider emits it). `gantry-admin` installed via API, exercised via read-only `admin_permission_list`. |
| MCP lifecycle | In-process Streamable HTTP test server (extend the existing `inline-agent-runtime.integration.test.ts:328-357` pattern) exposing `echo` + `get-sum` — do NOT depend on `@modelcontextprotocol/server-everything@2.0.0` (does not exist; E404). Only echo+get-sum approved; discovery, schema, `get-sum(20,22)=42`, output validation, denied-tool invisibility, MCP audit. |
| Permission real-turn | One real turn where a RunCommand is permission-decided (deterministic provider issues it; decided via current auto/human path) + audit recorded. |
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
`.github/workflows/agent-e2e.yml`, triggers: PR open/synchronize/reopen/label/unlabel.
- Hermetic E2E + (extended) test:integration:postgres run for every non-docs PR.
- Path-map (checked-in globs → risk area) classifies changed paths. UNKNOWN stays
  RISKY for live-gate purposes until the path-map is updated; `e2e-reviewed` may
  ACKNOWLEDGE a mapping miss but MUST NOT silently downgrade unknown code to
  non-risky.
- Risky PRs fail until `live-agent-e2e`; the label starts the protected-environment
  live job against the immutable prebuilt image artifact (same digest, never a
  rebuild).
- **Fork-secret safety:** protected model secrets never exposed to untrusted fork
  PR code. Trust boundary = same-repository PRs + protected-environment approval,
  or a trusted workflow executing an already-built reviewed artifact. NO
  `pull_request_target` checkout of PR code.
- `agent-e2e-gate` aggregates all results. Branch-protection/ruleset activation +
  verification of the exact required check name is IN SCOPE (a workflow check is
  not a required gate by itself).

## Failure & evidence policy
- Hermetic failures NOT retried. Live 429/5xx/timeout/transport retried once; a
  retry-pass = `FLAKY` and STILL blocks merge.
- Success AND failure upload redacted JSON evidence + audit/event extracts +
  container logs + timings + targeted rerun command.

## Budget — rebaselined (validation §8)
15 min is a TARGET, not a validated criterion. Restage with: per-shard wall-clock
budgets, a Docker layer-cache/artifact strategy, and MEASURED cold + warm
baselines. If the cold required gate can't reliably finish under 15 min with
headroom, RAISE the timeout rather than make a flaky performance promise. (Current
CI allows 30 min / 900s per command.)

## Surface Impact Matrix (corrected)
| Surface | Classification | Reason |
|---|---|---|
| Runtime behavior | Changed | Deterministic test provider is part of the exact packaged image (test-config-gated). |
| `settings.yaml` | Read-only/observable | Isolated desired-state ops; verify synchronized output. |
| Postgres/runtime projection | Read-only/observable | Disposable rows verify revisions, bindings, restart projection, transient expiry. |
| Control API | Read-only/observable | Existing endpoints exercised. |
| SDK/contracts | Unchanged by design | Existing clients reused; new types test-internal. |
| CLI | Unchanged by design | No CLI feature added. |
| Gantry MCP/admin skill | Read-only/observable | Exercised without changing authority. |
| Channel/provider adapters | Providers observable; channels deferred | Both harnesses tested; channel UI/approval out of gate. |
| CI workflow / GitHub ruleset | Changed | New workflow, path-map, aggregator, branch-protection activation. |
| Image packaging / provenance | Changed | Immutable artifact handoff; deterministic provider in image; skill-install-via-API. |
| Docs/prompts | Changed | This goal prompt + CI/scenario/evidence docs. |
| Audit/events | Read-only/observable | Existing events become assertions/evidence. |
| Tests/verification | Changed | Runner, fixtures, packaged harness, granular integration additions, live matrix, policy classifier, aggregator, i-have-adhd guard. |
| Deployment workflows | Deferred | Deploy automation + real TG/Slack canaries excluded; pre-merge CI in scope. |

## Acceptance criteria
- All existing suites green. Extended `test:integration:postgres` runs in CI and gates.
- Hermetic agent E2E completes a REAL turn via the deterministic provider with NO
  internet or model credentials.
- Granular permission (every current-semantics mode+path) and capability (every
  lifecycle stage) pass at the integration layer, each citing existing coverage +
  its added gap.
- Risky PRs can't merge without `live-agent-e2e` + passing live matrix; UNKNOWN
  path changes stay risky; fork PRs never see protected secrets.
- `agent-e2e-gate` is the verified required branch-protection check.
- `i-have-adhd` zero references in E2E surfaces (scoped guard).

## Non-goals
- Deploy automation; real Telegram/Slack canaries. Production credentials in CI.
- Rebuilding granular logic already unit/integration-tested.
- Testing not-yet-built behavior (command-name promotion, conversation-scoped
  grants, auto_strict gate-bypass) — those get coverage when the permission lane
  ships them.

## Validation history
- Round 1 (2026-07-20): NOT APPROVED — critical blocker = no credential-free
  completed turn; + matrix-semantics drift, nonexistent fixture version, offline-
  fixture contradiction, image provenance/packaging gaps, merge-policy trust gaps,
  unproven budget. Report: `agent-e2e-plan-validation.md`. v2 resolves all 5
  minimum-restage items.
- Round 2: REQUIRED before implementation.
