# Getting started: basic to advanced

This path takes a practitioner from a local source build to a production
topology without skipping the authority and operations concepts between them.
Gantry is currently built from source; the package names shown in the docs are
the intended public shape until the first publish.

## Before you begin

You need Node.js `>=24 <26`, npm, Postgres, and `ripgrep`. Linux
`sandbox_runtime` additionally needs `bubblewrap` and `socat`. Use disposable
development credentials and a non-production database while learning.

Follow the [root setup instructions](../README.md#quick-start-from-source) to
clone, install, build, create `.env`, and start the runtime. Runtime home
defaults to `~/gantry` unless `GANTRY_HOME` or `--runtime-home` changes it.

## Level 1 — set up one runtime

Run the guided setup and verify the local control plane:

```bash
gantry setup
gantry doctor
gantry status
gantry start
```

Setup writes human-readable workstation configuration and persists desired
state through Postgres settings revisions. Put model credentials through
Gantry credentials and the Model Gateway; do not pass raw provider keys to an
agent process. If a check fails, resolve it before adding a channel or tool.

**Checkpoint:** `gantry doctor` and readiness are healthy, the intended model
alias resolves, and the runtime can restart without losing desired state.

Read: [runtime configuration](../README.md#runtime-configuration) and
[settings authority](architecture/overview.md#runtime-ownership).

## Level 2 — have the first conversation

The guided setup can create an agent, configure a Provider Account, discover a
conversation, and save a Conversation Install. These are distinct identities:

- the **agent** owns its configuration and durable authority;
- the **Provider Account** owns one provider-native identity and delivery route;
- the **Conversation Install** binds that agent and account to a conversation
  with trigger, sender, approver, memory, and delivery policy.

For an additional conversation, use the guided flow or the explicit CLI:

```bash
gantry conversation install \
  --agent <agent-id> \
  --provider-account <provider-account-id> \
  --conversation <conversation-id>
```

Send a harmless message, confirm the response returns through the exact
installed account, then restart Gantry and continue the same conversation.
Test a request that is denied or requires approval as well as a successful
turn.

**Checkpoint:** routing, trigger behavior, delivery, approval, durable message
history, and restart continuity match the install you reviewed.

Read: [provider configuration](architecture/multi-agent-provider-configuration.md)
and [the live-turn flow](architecture/runtime-flows.md#provider-message-to-durable-admission).

## Level 3 — operate more than one agent

Add complexity through explicit installs, not shared provider credentials.
One agent may be installed in several conversations. Several agents may share
a native conversation only when each has its own Provider Account/native
identity and triggers select the route. Ambiguous SDK, ingress, or scheduler
calls must name `agentId` or `providerAccountId`.

Native runtime subagents are a different concept. The optional
`AgentDelegation` capability projects a provider-native `Agent` tool inside a
parent run. Those subagents inherit the parent runner, sandbox, and capability
projection; they are not independently durable Gantry agents.

**Checkpoint:** every inbound route, credential owner, trigger, session scope,
and delivery identity is unambiguous; delegated work cannot widen the parent
run's authority.

Read: [multi-agent operation](architecture/system-atlas.md#identity-routing-and-multi-agent-operation)
and [agent composition](architecture/overview.md#agent-and-conversation-composition).

## Level 4 — learn the security and permission boundary

Treat model output, runners, provider SDKs, browser backends, MCP servers, and
local tools as untrusted execution surfaces. The host owns authorization,
credential brokering, sandbox policy, capability projection, and audit.

Start with narrow capabilities. Exercise `Allow once`, a denial, and—only when
the persistent scope is understood—`Allow for future`. Inventory or discovery
does not grant action authority: discovering an MCP source, installing a skill,
or receiving a file cannot authorize its actions. Compare `direct` and
`sandbox_runtime` as confinement choices; neither replaces host permission and
credential checks.

**Checkpoint:** the security owner can trace a risky action from request to
policy result, approval or denial, credential mediation, execution, and
terminal audit evidence.

Read: [security](SECURITY.md), [capability management](architecture/capability-management.md),
and the [interactive permission lifecycle](architecture/atlas/permission-execution.lifecycle.html).

## Level 5 — introduce memory intentionally

Gantry stores durable memory in Postgres with app, agent, and subject scope.
Lexical retrieval is always available; embedding-backed hybrid retrieval is
optional. Dreaming is a default-off maintenance path with durable decisions
and review flows. Provider transcript artifacts are not canonical memory.

Begin with a reversible, non-sensitive fact. Verify its evidence, scope,
recall, edit or deletion, and behavior in another conversation that should not
see it. Enable embedding or dreaming settings only after the basic scope is
observable.

**Checkpoint:** operators can explain where a memory came from, who can read
it, how it is reviewed, and how it is removed.

Read: [memory and dreaming](MEMORY.md) and the
[interactive memory dataflow](architecture/atlas/memory-dreaming.dataflow.html).

## Level 6 — use the SDK and APIs

Backend applications can use the Node-only `@gantry/sdk` over HTTP or a Unix
socket. The authenticated Control API exposes the same underlying services,
and generated OpenAPI types define its wire shapes. Never put a Control API key
in browser code.

Start with the runnable [local Control API example](../examples/control-api-local/README.md),
then use the [SDK quickstart](../packages/sdk/README.md#quickstart) to ensure a
session, send a message, and stream events. Add signed external ingress or
outbound webhooks only when their trust and retry boundaries are understood.

**Checkpoint:** API keys have the minimum scope, `/v1/*` stays on a trusted
network, clients handle timeout/retry without creating duplicate intent, and
durable events reconcile the final state.

Read: [SDK overview](../packages/sdk/README.md) and
[runtime ingress and delivery](architecture/runtime-flows.md).

## Level 7 — extend with reviewed capabilities

Choose the smallest surface that fits the work: a built-in host tool, skill,
browser capability, local CLI, or MCP server. Keep capability inventory,
selection, credentials, action authorization, sandbox policy, and audit as
separate checks. Remote HTTP/SSE MCP remains subject to the runtime's outbound
transport safety boundary; do not work around a fail-closed result.

Test the extension with missing and revoked credentials, denied permissions,
invalid input, unavailable dependencies, and a restart. For browser profiles,
test scope and lease behavior rather than treating a logged-in profile as
ambient shared state.

**Checkpoint:** removing the capability or credential closes the action path,
and every successful action records the expected evidence.

Read: [capability management](architecture/capability-management.md),
[browser capability](architecture/browser-capability.md), and
[system capability status](architecture/system-atlas.md#agent-model-and-capability-execution).

## Level 8 — operate with observability

Keep `/healthz`, `/readyz`, and `/metrics` internal. Use readiness for traffic
eligibility, then correlate metrics and logs with durable runs, jobs, events,
worker state, permission records, model usage/cache accounting, provider
delivery evidence, and settings revisions. A green process alone does not
prove that an agent turn can complete.

Rehearse provider failure, database interruption, denied approval, stalled
work, restart, backup restore, and settings projection failure. Write runbooks
for the signals your team actually observes.

**Checkpoint:** an operator can identify the owner and final state of a live
turn or job, distinguish provider failure from runtime failure, and recover
without duplicate delivery.

Read: [runtime flows and recovery](architecture/runtime-flows.md),
[deployment profiles](architecture/deployment-profiles.md), and
[debug checklist](DEBUG_CHECKLIST.md).

## Level 9 — prepare a fleet deployment

First exercise production security posture and explicit capacity limits on one
`all`-role host. A fleet runs the same binary as `control`, `live-worker`, and
`job-worker`; Postgres coordinates durable work and every claimant must see the
same artifact bytes.

The topology is implemented, but two current authorities—rate limits and LLM
concurrency admission—are process-local. The current safe production contract
therefore remains a single runtime instance for rate-limit purposes until the
cluster-authoritative work is completed and its decision is superseded. Use a
fleet as a bounded rehearsal target, not as an implied scaling guarantee.

**Checkpoint:** shared Postgres and artifact storage, process routing,
readiness, provider connection ownership, fencing, drain, recovery, settings
convergence, resource budgets, and the process-local ceilings all have tested
answers.

Read: [scaling and deployment](architecture/scaling-and-deployment.md),
[fleet execution](architecture/atlas/fleet-execution.architecture.html), and
the [company readiness guide](product/company-adoption-guide.md#production-readiness-questions).

## Keep the learning loop honest

At every level, record the configuration, source revision, test input, expected
result, observed result, and rollback. Advance only when the responsible owner
accepts the evidence. The [static project explorer](index.html) keeps the four
reader paths and five interactive architecture views available without a
build system or network connection.
