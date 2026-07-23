# Agent E2E CI Merge Gate — Plan Validation Round 3

Status: **NOT APPROVED FOR IMPLEMENTATION**

Validated: 2026-07-20

Scope: adversarial validation of
`agent-e2e-ci-merge-gate-goal-prompt.md` v3 against branch
`feature/agent-e2e-gate` at `5725efd85`. This report is the only file changed.
No live model credential was available to execute the proposed real turn, so
model feasibility below is a current-tree path proof, not a successful live-run
claim.

## Executive verdict

V3 removes round 2's deterministic-provider blocker. A real `haiku` turn is
architecturally feasible through the normal Gantry credential broker, loopback
model gateway, Anthropic adapter, and worker sandbox when CI supplies the model
credential through the Control API and launches the container with the proven
namespace-capable sandbox posture.

The overall plan is still not implementation-ready. Its required Control API
turn does not target the freshly-created agent: the session contract accepts
`agentId`, but the route drops it and creates a synthetic app-session folder.
There is also no Control API for a transient permission decision, generic
conversation creation, per-agent model mutation, custom semantic-capability
registration, or complete effective-runtime-tool enumeration. The packaged
image contains neither Chrome nor `gog`, the stated loopback MCP server is in the
wrong network namespace, and the proposed Slack bot message is ignored by
Gantry while a Slack Web API call cannot manufacture a user's button click.

Three regression scenarios described as fixes already "landed/landing" are also
not present at this HEAD: MCP initialization still hard-requires `connected`,
route loading still retains stale `conversationId` data and has no qualified-row
dedup rule, and persistent permission approval still sends a chat receipt.
Those are production behavior changes, not read-only E2E assertions.

| Component | Verdict | Round-3 result |
|---|---|---|
| Real `haiku` model boundary | **NEEDS-RESTAGE** | The round-2 blocker is gone and the route is feasible, but v3 must pin worker runtime, credential-API ingestion, direct host-gateway egress, and the Docker sandbox launch posture. Completion is not yet demonstrated by an existing test. |
| API-for-everything | **NOT-SAFE** | Several required mutations have no purpose-built API, permission decisions have no API at all, and session ensure does not target the onboarded agent. |
| Fresh onboarding and required turn | **NOT-SAFE** | Agent creation and discovered-conversation binding exist, but the planned session turn exercises a synthetic folder, not that agent or its grants. |
| All-tools exercise and effective-set discovery | **NOT-SAFE** | The access API is not an effective runtime manifest, and "every tool" includes stateful/authority/lifecycle tools that do not form one safe invocation contract. |
| Tiered external dependencies | **NOT-SAFE** | Chrome and `gog` are absent from the exact image; arbitrary local CLIs cannot generically be redirected; the proposed loopback MCP topology is container-inaccessible. |
| Label-gated Slack channel loop | **NOT-SAFE** | Bot-authored inbound messages are ignored, and approval requires a real user interaction or a separately-scoped signed callback fixture. |
| Four named regression scenarios | **NOT-SAFE** | One is already expressible, while three assume production fixes absent from this tree; route corruption also cannot be created through supported APIs. |
| `gantry-admin` correction | **NEEDS-RESTAGE** | The actual scenario correctly calls `admin_permission_list`, but earlier v3 prose still directs an impossible reserved-name install. |
| Image provenance and fork trust | **NEEDS-RESTAGE** | `docker save` intent is improved, but head-SHA/digest verification, stale-artifact rejection, artifact identity/retention, and safe fork execution remain unspecified. |
| Budget and fixture closure | **NEEDS-RESTAGE** | The document again asks a later implementer to measure and choose values; source identity and container/network topology remain unpinned. |
| Surface Impact Matrix | **NEEDS-RESTAGE** | It uses invalid classifications and says runtime/image/contracts are unchanged despite changes required by its own scenarios. |

## 1. Model boundary

Verdict: **NEEDS-RESTAGE**, with the round-2 blocker resolved.

### What is now feasible

`haiku` is a real catalog alias for `claude-haiku-4-5-20251001`, advertises tool
support, and routes through `anthropic:claude-agent-sdk`
(`apps/core/src/shared/model-catalog.ts:453-464`;
`apps/core/src/shared/model-provider-registry.ts:240-246`). Anthropic's fixed
upstream is `https://api.anthropic.com`
(`model-provider-registry.ts:204-211`).

CI can ingest the protected secret through
`PUT /v1/credentials/models/anthropic`; that route requires
`credentials:admin` and accepts an `api_key` payload
(`apps/core/src/control/server/routes/credentials.ts:29-80,97-112`). The gateway
then requires the app-scoped active credential, issues a run-scoped token, and
projects a loopback base URL plus the token rather than the raw upstream secret
(`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts:135-155,187-201`).
The worker spawn obtains that projection before adapter preparation and launches
the normal provider path (`apps/core/src/runtime/agent-spawn.ts:254-320`).
Inline obtains the same gateway projection and is feasible for a narrow
model/core-tool turn (`apps/core/src/runtime/agent-inline.ts:233-248`), but it
cannot run v3's attached-skill/local-CLI/Browser all-tools scenario.

The disposable Postgres/image shape is also viable: the packaged entrypoint
resolves the schema, runs the explicit migrator, seeds initial projection, and
then starts the runtime (`ops/docker/entrypoint.sh:37-69,192-219`). Preserve the
same database/schema, `GANTRY_HOME`, and encryption key across the planned
restart.

### Conditions v4 must lock

1. **Credential ingestion:** the harness reads the protected CI secret and sends
   it through the credential API. Do not inject `ANTHROPIC_API_KEY` as ambient
   Gantry process authority. Supply strong encryption and IPC secrets plus the
   exact Control API scopes.
2. **Worker runtime:** explicitly create/configure and assert `runtime: worker`.
   Inline rejects attached skills and worker-only Browser, RunCommand,
   filesystem, local-CLI, and skill-action surfaces
   (`apps/core/src/runtime/agent-spawn-admission.ts:101-132`;
   `apps/core/src/shared/agent-runtime.ts:31-55`).
3. **Sandbox launch:** the image includes `bubblewrap`, but Docker must permit its
   namespace creation (`ops/docker/Dockerfile:71-84`). The proven fleet shape
   uses `security_opt: seccomp=unconfined`
   (`ops/docker/docker-compose.fleet.yml:42-47`). Pin that or an equivalent
   user-namespace-capable profile and fail fast with a sandbox smoke.
4. **Egress:** the sandboxed SDK reaches a loopback/private alias; the host model
   gateway performs the direct TLS request to `api.anthropic.com`
   (`apps/core/src/runtime/agent-spawn-runtime-policy.ts:360-389`;
   `gantry-model-gateway.ts:400-480`). The CI network must allow container DNS/TLS
   egress on that host path. A proxy-only assumption is unsupported as written.
5. **Honest proof status:** current two-process E2E uses a deterministic child,
   disables the credential broker, and does not prove this live composition
   (`apps/core/test/e2e/claim-protocol-two-process.postgres.e2e.test.ts:424-450`). V4 may
   specify this test as the proof to add; it may not describe completion as
   already established.

V3 also says the model API is the only permitted external call
(`agent-e2e-ci-merge-gate-goal-prompt.md:45-48`) while later requiring real Slack
and Google Sheets calls (`:189-200`). Define that restriction per shard rather
than globally.

## 2. API-for-everything inventory

Verdict: **NOT-SAFE**.

| Required operation | Current API reality | Result |
|---|---|---|
| Create agent | `POST /v1/agents` exists and syncs desired state (`apps/core/src/control/server/routes/agents.ts:155-194`). The hand SDK has no create/list/update wrapper (`packages/sdk/src/index.ts:506-548`; `packages/sdk/src/agents.ts:60-98`), so use raw/generated HTTP or add SDK coverage. | **SAFE via Control API** |
| Create conversation | `/v1/conversations` is GET-only; canonical conversations are produced through provider-account discovery (`apps/core/src/control/server/routes/provider-conversation-routes.ts:292-359`). | **NO generic API** |
| Bind agent to conversation | `PUT /v1/agents/{agent}/conversation-installs/{conversation}` persists, projects, and syncs (`apps/core/src/control/server/routes/provider-conversation-routes.ts:490-523`). It requires a discovered existing conversation. | **SAFE conditionally** |
| Set model | `PATCH /v1/models/defaults` can set the isolated app's global chat default (`apps/core/src/control/server/routes/models.ts:625-687`). Agent create/update accepts harness but not model (`packages/contracts/src/agents/index.ts:83-99`). Per-agent `model` is available only through full desired-state replacement (`packages/contracts/src/settings/index.ts:117-150`). | **Global API SAFE; no per-agent model API** |
| Store model credential | Model credential GET/PUT/PATCH/DELETE exists (`apps/core/src/control/server/routes/credentials.ts:29-177`); the hand SDK lacks a convenience client. V3 currently omits this required setup call. | **SAFE via Control API** |
| Install/select skill | Zip install exists (`apps/core/src/control/server/routes/skills.ts:54-119`); selection is a separate agent-skill PUT (`apps/core/src/control/server/routes/skills.ts:183-216`). | **SAFE** |
| Register/select MCP | Admin `POST /v1/mcp-servers` immediately creates an active definition (`apps/core/src/control/server/routes/mcp-servers.ts:48-85`; `apps/core/src/application/mcp/mcp-server-service.ts:54-139`); agent binding exists (`apps/core/src/control/server/routes/mcp-servers.ts:213-270`). There is no separate pending approval endpoint. | **SAFE if restaged as admin connect + bind** |
| Select an existing capability | `PUT /v1/agents/{id}/access` exists and syncs settings (`apps/core/src/control/server/routes/capability-catalog.ts:85-124`). | **SAFE via Control API** |
| Register a custom semantic/local-CLI capability | `/v1/capabilities` and `/v1/inventory` are GET-only (`apps/core/src/control/server/routes/capability-catalog.ts:44-83`). Access replacement can select only trusted catalog/skill-action definitions. Installing a reviewed skill action can indirectly add a skill-owned definition, but there is no standalone generic capability-registration API. | **NO generic API** |
| Decide a transient permission prompt | No Control route accepts a pending-interaction decision. Session POST accepts only a new message/control input (`sessions.ts:246-301`); decisions flow through channel callbacks/runner IPC. Admin permissions support list/revoke, not approve. | **NO API** |
| Seed a persistent tool rule | The generic `PUT /v1/settings/desired-state` can replace `agents.<folder>.toolRules` (`routes/settings.ts:81-135`; `packages/contracts/src/settings/index.ts:145`). That is preconfiguration, not a request/decision proof. | **Desired-state API only** |
| Enumerate effective runtime tools | `GET /v1/agents/{id}/access` reports configured access, but its builder hard-codes `defaultTools: []` (`apps/core/src/shared/tool-access-view.ts:104-120`). It omits composed baseline Gantry, native SDK, resolved MCP, harness, and runtime-dependent tools. | **NO effective-manifest API** |
| Tear down agent/session | Agents can be disabled and bindings removed, but there is no agent or session delete route. | **No object teardown API; destroy disposable environment** |

V3's blanket assertion that every setup operation appends a settings revision is
also wrong (`agent-e2e-ci-merge-gate-goal-prompt.md:141-143`). Desired-state
mutations such as agent/access/binding changes should append/sync. Catalog,
credential, session, and MCP-connect operations should instead prove their own
durable catalog, encrypted-credential, audit, or session records.

### Critical session-to-agent mismatch

This is the immediate blocker to the proposed packaged proof. The shared create
session contract accepts `agentId` (`packages/contracts/src/sessions/index.ts:14-27`),
but `/v1/sessions/ensure` ignores it and passes only app/conversation fields
(`apps/core/src/control/server/routes/sessions.ts:139-189`). The application then
constructs `app:<appId>:<conversationId>` and a synthetic
`app_<hash>_<app>_<conversation>` folder
(`apps/core/src/application/sessions/session-interaction-module.ts:104-152,507-529`),
which is registered directly into the runtime
(`apps/core/src/control/server/session-interaction-adapter.ts:38-47`).

Consequently, v3 can create an agent and attach skills/MCP/capabilities to it,
then complete a real Control API turn, while the turn exercises a different
synthetic identity. The assertions cannot bridge that gap after the fact. V4
must either implement and contract-test session-to-`agentId` targeting or choose
a real discovered conversation route bound to the agent. The latter would make
the external provider lane mandatory and conflicts with Slack being label-gated.

## 3. All-tools exercise and external tiers

Verdict: **NOT-SAFE**.

### "Every effective tool" is not a stable gate contract

The runtime composes native tools, Gantry MCP tools, skills, external MCP tools,
admin gates, scheduler context, browser state, and semantic capability rules
inside the worker (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts:309-390`;
`agent-capabilities.ts:167-245,499-542`). The public access view does not expose
that resolved set.

The baseline Gantry surface alone contains messaging, questions, renderers,
memory and brain writes, skill/MCP/access requests, file/profile mutation, and
tool-proxy calls (`apps/core/src/runner/gantry-mcp-tool-surface.ts:12-43`). Optional
surfaces add scheduler, asynchronous-task, delegation, browser, reviewer-memory,
and admin operations (`:45-144`). Those tools have different state, roles,
lifecycle preconditions, and side effects. Visibility is not a promise that every
tool is meaningful or safe to call once in one scenario.

A real model can also choose not to issue a requested tool call. Behavioral
assertions remove reply-text fragility, but do not make exhaustive model-directed
tool choice deterministic. The single allowed retry is explicitly a blocking
`FLAKY` result, so adding dozens of mandatory model choices creates a high-noise
merge gate.

Minimum safe shape: deterministically test the resolved tool manifest/projection
and one representative tool per execution boundary; use the real Haiku packaged
smoke only for a small curated set (for example one Gantry tool, one selected
skill, one MCP tool, one attended permissioned RunCommand, and one preselected
semantic capability). Keep stateful/authority-changing/admin/scheduler lifecycle
tools in focused deterministic tests.

### Tier feasibility

- **Browser — blocked in the exact image.** The image installs no Chrome/Chromium
  (`ops/docker/Dockerfile:65-113`). Linux resolution only chooses candidate paths
  (`apps/core/src/shared/chrome-executable.ts:3-17`), and the host capability
  spawns that executable then waits for CDP
  (`apps/core/src/runtime/browser-capability.ts:348-444`). This requires an image
  content/runtime change (including a workable headless/display posture) or
  removal from the packaged lane.
- **`gog`/Sheets — blocked in the exact image.** No `gog` implementation or binary
  exists in production code/image; the Dockerfile also removes npm/npx. A real
  credential cannot make the executable exist. A reviewed local CLI further
  requires an absolute executable identity, pinned version/hash, preflight, and
  exact command templates (`apps/core/src/application/jobs/job-capability-requirements.ts:144-190`).
  Package and inventory a pinned binary in a separately scoped change, or remove
  real Sheets from this gate.
- **Arbitrary local-CLI stubs — not generic.** A capability can target loopback
  only if its pinned executable and exact reviewed command template actually
  support an endpoint override. Replacing arbitrary CLIs with one purpose-built
  fixture proves the RunCommand/local-CLI boundary, not every real capability.
- **Loopback MCP — supported only in the same network namespace.** HTTP is allowed
  for a loopback IP (`apps/core/src/application/mcp/mcp-server-policy.ts:101-127`).
  An in-process server in the host test process is not the packaged container's
  `127.0.0.1`; a sibling's private non-loopback HTTP destination is rejected.
  Pin an in-container fixture process/mount and lifecycle, or use an allowed
  authenticated HTTPS fixture. The current in-process citation is insufficient.
- **Native web tools — not loopback-substitutable as a class.** `WebSearch` and
  `WebFetch` are native SDK tools (`native-sdk-tools.ts:1-23`), not Gantry local
  capabilities whose backend URL the test can replace. At least `WebSearch`
  cannot satisfy "every external except Slack/Sheets/model goes to loopback."
- **Network isolation — not proved.** V3 correctly acknowledges that
  `networkHosts` is attribution under a default-allow public gateway
  (`agent-e2e-ci-merge-gate-goal-prompt.md:128-132`). Therefore the claimed
  external-call boundary needs an actual per-shard Docker/firewall policy and a
  negative probe; capability metadata does not enforce it.

These are product/image/runtime concerns, not test-only fixtures. Splitting
browser packaging, `gog` lifecycle, and effective-tool introspection into their
own approved plans is simpler than expanding this merge-gate change until it
owns every integration.

## 4. Fresh onboarding and Slack channel loop

### Fresh onboarding

Verdict: **NOT-SAFE** for the required lane.

Creating an agent is supported. Binding is supported only after a provider has
discovered a canonical conversation. There is no provider-neutral conversation
create API, and the Control session mismatch means the required turn does not
exercise the fresh agent. Teardown should explicitly mean destroying the
disposable schema/container; individual agent and session deletion is not
available.

### Slack channel loop

Verdict: **NOT-SAFE as specified**; label gating itself is **SAFE**.

`chat.postMessage` posts as the app, bot, or user associated with the token. With
the proposed bot token it posts as the bot, while Gantry deliberately ignores
Slack events carrying `bot_id`
(`apps/core/src/channels/slack/channel-message-ingest.ts:98-102`;
[Slack `chat.postMessage`](https://api.slack.com/methods/chat.postMessage)). The
scenario therefore needs a separate test-user OAuth token/identity with channel
membership, not only bot/app tokens.

Slack sends a `block_actions` payload when a user clicks an interactive button;
it is not a Web API method the harness can call
([Slack block-action payload](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload)).
Gantry also authorizes the real callback user
(`apps/core/src/channels/slack/channel-interactions.ts:261-320,365-410`). Choose:

1. a logged-in test user plus browser/UI automation, which is a real external
   channel loop and requires a separate UI credential/cleanup contract; or
2. a correctly signed synthetic Slack action POST, which is valuable adapter
   coverage but is not a full external Slack loop and should be named that way.

The approval prompt is ephemeral to configured approvers
(`apps/core/src/channels/slack/permission-approval-delivery.ts:118-159`), so the
test also needs a real approver member and cannot inspect it through ordinary
channel history. Define run serialization, message/thread cleanup or retention,
rate-limit handling, and test-user/app membership.

## 5. Named regression scenarios

Verdict: **NOT-SAFE against this HEAD**.

| Scenario | Tree truth | Required correction |
|---|---|---|
| MCP-readiness race | `assertRequiredMcpServerReady` rejects every status except literal `connected` (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/mcp-server-validation.ts:61-81`). | Stage the production invariant/fix first and unit-test its terminal/transient status set. A live model call cannot deterministically manufacture SDK initialization timing; keep the race at an injectable boundary, then add only a thin packaged smoke. |
| Route-loader corruption | Loader iteration merely overwrites duplicate JIDs in creation order (`canonical-binding-ops-service.ts:29-35`). `bindingRowToGroup` still prefers stale `memorySubject.route.conversationId` (`canonical-binding-repository.postgres.ts:167-212`). | Implement canonical-on-read and the qualified-row dedup rule first. Supported APIs cannot create the historical corrupt row, so permit a bounded repository/SQL fixture in a Postgres integration test rather than claiming API-for-everything. |
| Autonomous tool dead-end | Job creation accepts `accessRequirements`; readiness returns a durable `missing_capability`/`setup_required` blocker before spawn (`apps/core/src/application/jobs/job-readiness-service.ts:95-128,335-378`). Existing unit coverage already proves missing Browser pause/event behavior. | **Expressible.** Add a thin API/Postgres assertion only. Pin a declared access requirement; an undeclared tool the model happens to choose cannot be preflighted. |
| Permission-receipt silence | Persistent grant application explicitly calls `sendPermissionOutcomeMessage` (`apps/core/src/runtime/ipc-interaction-processing.ts:231-264`), and current unit tests expect it. | This is a production behavior change plus test replacement, not a regression-only assertion. Stage it and its channel effects explicitly. |

Calling three absent changes "landed/landing" while classifying runtime as
read-only makes the handoff non-executable. V4 must either land and cite their
commits before this goal starts or include their production files/tests as
Changed scope. Mixing independent product fixes into an already broad CI gate is
the riskier option.

## 6. Round-2 restage closure

| Round-2 item | Round-3 result |
|---|---|
| Deterministic-model blocker | **Resolved in direction.** Real Haiku uses the production broker/gateway path. Conditional launch details remain. |
| `gantry-admin` | **Partially resolved.** The scenario at goal line 253 correctly does not install the reserved skill and instead calls `admin_permission_list`. Lines 81-85 still say to install it through `/v1/skills/install`, contradicting the scenario and the reserved-name guard. Delete the stale instruction. |
| Image provenance | **Not decision-complete.** Lines 77-80 still choose artifact **or** registry; the matrix later assumes `docker save`. Pin artifact name, retention, compression/load commands, recorded image ID/digest, head-SHA metadata/check, and rejection after a synchronize event. |
| Fork trust | **Not decision-complete.** A protected workflow executing a fork-built artifact with a reusable credential remains unsafe merely because the artifact was transferred. Require protected-environment approval bound to the reviewed exact head SHA/digest, or do not run the secret-bearing lane for forks. Never execute checked-out fork code in a privileged workflow. |
| Budget | **Unresolved.** Lines 311-326 repeat "Restage with" measured cold/warm baselines and per-shard budgets but contain no measurements, budgets, cache choice, or final timeout. The real model/all-tools expansion makes this worse, not resolved. |
| Offline fixtures | **Unresolved.** `internal-comms` still lacks a literal source URL, commit, license identifier/path, and expected archive/content hash. The MCP fixture's container placement and the enforceable network boundary remain unspecified. |
| Surface matrix | **Incorrect.** `Gate target (contract-tested)` and `Providers observable; Slack...` are not allowed classifications. Runtime behavior cannot be Read-only if three regression fixes are in scope; image provenance cannot say no image content change while Browser/`gog` are required; SDK/contracts cannot be Unchanged if session targeting/effective-manifest/permission APIs are added. Split mixed rows and give every Deferred/Unchanged row a reason. |

The goals index also still describes the obsolete "everything server" fixture
(`docs/architecture/goals-index.md:82-85`). Remove that contradiction in the
eventual goal-doc restage, not in this report-only pass.

## 7. New v3 problems and over-engineering

1. **The required turn and onboarded agent are disconnected.** This lets the gate
   appear green while proving none of the created agent's selections.
2. **The universal tool quantifier is the wrong abstraction.** It converts every
   future tool addition into a costly, probabilistic live-model merge-gate
   obligation, including destructive or role-specific lifecycle tools.
3. **The test plan now hides several product features.** Effective-tool
   introspection, session-to-agent targeting, permission-decision API, custom
   capability registration, Chrome packaging, and `gog` distribution are not
   fixture details.
4. **The external tiers contradict each other.** The same required lane says only
   the model may use external network, yet the comprehensive proof includes
   label-gated Slack, real Sheets, and native web tools.
5. **Fork behavior is not a complete required-check state machine.** "Route
   through the trusted-artifact path" does not say who reviews/approves the exact
   head, how stale artifacts are rejected, or how a fork PR obtains a required
   aggregate result without exposing a secret.

The simplest correct goal is smaller: deterministic composition/manifest and
policy coverage below the model boundary, plus one curated real-Haiku packaged
worker smoke. Keep external Slack UI, Browser image support, and real `gog`
Sheets as independently-owned, label/schedule-gated streams.

## Minimum v4 restage set

1. **Seal identity and API authority.** Implement or explicitly stage
   session-to-`agentId` targeting; choose global-default versus desired-state
   per-agent model selection; add a pending-interaction decision API if the
   permission proof must remain API-driven; either add generic conversation and
   custom-capability registration or remove those claims. Limit revision
   assertions to desired-state mutations.
2. **Replace "all tools" with a bounded proof contract.** Add a deterministic
   runtime-effective manifest/projection assertion (or a versioned scenario
   manifest), then run a curated real-Haiku set covering each execution boundary.
   Do not make every stateful, authority-changing, scheduler, admin, or native web
   tool a model-directed merge requirement.
3. **Separate and stage missing product work.** Land the MCP readiness invariant,
   route canonicalization/dedup, and permission-receipt behavior before the gate,
   or mark their runtime files/tests Changed. Split Chrome/browser packaging,
   `gog` binary/credential lifecycle, and effective-tool API work into their own
   approved plans unless they are removed from the required gate.
4. **Make external topology and trust executable.** Put the MCP fixture in a
   container-reachable location; pin skill provenance and hashes; define
   per-shard firewall/negative probes; redesign Slack with a test user plus real
   UI click or call the signed callback test synthetic; bind image artifact ID,
   digest, and protected approval to the exact current head, including fork and
   synchronize behavior.
5. **Finish the operational contract.** Provide measured cold/warm timings,
   per-shard budgets/timeouts, cache/artifact policy, exact ruleset/check
   activation and verification, valid Surface Impact Matrix statuses, and remove
   the stale `gantry-admin`/everything-server contradictions.

## Overall decision

**NOT APPROVED FOR IMPLEMENTATION.** V3 makes the production real-model route a
sound direction, but the proposed API turn cannot reach the agent it claims to
test, multiple mandatory APIs and packaged executables do not exist, three
regression prerequisites contradict the current tree, and the round-2
provenance/budget/fixture/matrix restages remain incomplete. The five v4 items
above are the minimum coherent restage; implementation before those decisions
would either fail mechanically or silently prove a different system than the
goal describes.
