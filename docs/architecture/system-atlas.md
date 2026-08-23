# Gantry System Atlas

This is the current capability map for Gantry at source revision `69ac5b7`.
It describes shipped behavior, optional surfaces, disabled defaults, recorded
deferrals, and product non-goals without treating historical goal documents as
runtime truth. The evidence behind the map is in the
[source manifest](./atlas/source-evidence.md); the interactive
[system view](./atlas/gantry-system.architecture.html) shows the same boundaries.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **Current** | Shipped and part of the normal runtime contract when its owning surface is configured. |
| **Optional** | Shipped, but used only when an operator selects the provider, capability, execution mode, or deployment shape. |
| **Default off** | Shipped opt-in behavior whose default setting is disabled. |
| **Deferred** | Recorded future work or a known parity gap; do not describe it as available. |
| **Non-goal** | Deliberately outside Gantry's product or authority boundary. |

These labels describe product availability, not maturity, throughput, or a
security certification. A feature can be current and still carry an explicit
operational limit.

## Product boundary and ingress

| Feature family | Status | Current contract |
| --- | --- | --- |
| Provider-neutral conversations | **Current** | Canonical apps, agents, provider accounts, conversations, threads, messages, and sessions keep provider payloads behind channel adapters. |
| Slack, Telegram, Teams, Discord, and app channels | **Optional** | A deployment enables the adapters and provider accounts it needs. The app adapter carries SDK/control-API conversations over the same runtime path as chat providers. |
| Server-side SDK and control API | **Current** | `@gantry/sdk` and HTTP expose sessions, runs, jobs, settings, providers, credentials, memory, brain, capabilities, events, usage, and health within API-key scope. |
| Signed external ingress | **Optional** | `/v1/ingresses/:id/invoke` accepts authenticated application action requests under target policy. An ingress request describes work; it never grants tools. |
| HTTP SSE, SDK list/wait, and outbound webhooks | **Optional** | These observe or deliver durable runtime events. They are outbound paths, not additional agent response authorities. |
| Gantry-hosted multi-tenant SaaS | **Non-goal** | Gantry is customer-operated. Isolation inside a customer's deployment remains important, but Gantry is not sold here as a hosted control plane. |
| General workflow engine | **Non-goal** | Jobs schedule governed agent work; Gantry does not replace an arbitrary workflow orchestrator. |

## Identity, routing, and multi-agent operation

| Feature family | Status | Current contract |
| --- | --- | --- |
| Provider Accounts | **Current** | One provider-native identity belongs to one agent and owns non-secret config plus runtime secret references. One account starts one adapter; events never fall back to another account. |
| Conversation Installs | **Current** | An install binds an agent and its provider account to a canonical conversation with trigger, sender, approver, memory, and delivery policy. |
| One agent in many conversations | **Current** | The same agent and provider account can be installed in several conversations. Conversation/thread sessions and delivery remain isolated; agent-owned durable authority and agent memory can intentionally span those installs according to scope. |
| Several agents in one native conversation | **Current** | Each installed agent uses its own provider account/native identity. Triggers select the route; ambiguous SDK, ingress, and scheduler calls must name `agentId` or `providerAccountId`. |
| Several provider accounts for one agent | **Current** | Accounts remain separate credential and delivery identities even when they lead to the same agent. |
| Provider-specific application logic in core | **Non-goal** | Provider behavior belongs in adapters; application/domain code depends on stable Gantry concepts and ports. |

See [multi-agent provider configuration](./multi-agent-provider-configuration.md)
for installation patterns and exact isolation boundaries.

## Durable runtime and execution

| Feature family | Status | Current contract |
| --- | --- | --- |
| Postgres canonical state | **Current** | Apps, agents, conversations, messages, sessions, runs, settings revisions, jobs, leases, events, permissions, memory, and artifact metadata are durable Postgres state. Provider JSONL and temporary runner files are not continuity authority. |
| Durable inbound admission | **Current** | Normalized inbound content and its route are persisted before execution. Admission claims are atomic and recoverable; overload waits durably rather than dropping work. |
| One active live turn per scope | **Current** | A partial unique constraint serializes `(app, agent session, conversation, thread)`. Losing workers cannot finalize recovered work because leases carry monotonically increasing fencing versions. |
| Provider-history hydration | **Current** | The provider adapter can fill bounded history gaps, but stored canonical context remains authoritative once coverage is proven. The final message fetch before a turn is intentionally retained to avoid losing mid-admission messages. |
| Session continuity | **Current** | Canonical agent sessions, digests, provider resume metadata, and conversation aggregates support continuation. Provider session artifacts are adapter metadata, not canonical history. |
| Conversation files | **Current** | Provider limits apply: live Slack, Telegram, and Discord files use the hardened 50 MiB descriptor-pinned writer; Slack and Discord support durable historical refetch. Access is conversation-scoped where the attachment resolver has landed. |
| Teams file download parity | **Deferred** | Teams has metadata-only coverage until a real provider SDK/download client exists. Linked Drive, Dropbox, and SharePoint files require connector work. |

## Agent, model, and capability execution

| Feature family | Status | Current contract |
| --- | --- | --- |
| Provider-neutral agent execution adapter | **Current** | Harness selection is host-owned. DeepAgents and the Claude Agent SDK sit behind the same execution adapter contract. |
| Native SDK subagents | **Optional** | `AgentDelegation` projects to the provider-native Agent tool inside the parent runner. Subagents inherit the parent run, sandbox, and capability projection; they are not independently durable Gantry agents. |
| Model catalog aliases and presets | **Current** | Agents and memory lanes select provider-neutral aliases. The host resolves approved provider credentials and records usage/cache accounting. |
| Loopback model gateway | **Current** | Runners receive a short-lived Gantry token; the trusted host injects real provider authentication. Raw model credentials are not materialized into the agent workspace. |
| Skills, Gantry MCP tools, external MCP, browser, files, messaging, scheduler, memory, and brain | **Optional** | Selected capabilities are composed at spawn and projected into the runner. Discovery of an MCP source does not itself authorize an MCP action. |
| Capability artifacts | **Current** | Installed skill bytes live behind an artifact store; metadata, ownership, versions, bindings, and lifecycle live in Postgres. Fleet claimants need shared byte visibility. |
| Browser | **Optional** | Browser is a policy-gated host capability with persistent profiles scoped by agent/conversation/thread/job context and protected by a durable advisory lease. |
| Signed public artifact links | **Deferred** | Public signed delivery links are not part of the current artifact contract. |

## Security and authority

| Feature family | Status | Current contract |
| --- | --- | --- |
| Host permission coordinator | **Current** | The host applies hard deny, locked preset, fixed-image restriction, reviewed agent authority, deterministic rails, optional cached classifier allow, optional risk classifier, then durable human approval. Optional stages are skipped on lanes that do not provide them. |
| Risk-only classifier | **Optional** | The classifier advises `low/medium/high/critical` risk; it never invents authorization. Errors and high/critical unowned actions require approval. |
| Durable human approval | **Current** | `Allow once` is transient and never reused. Learned trusted roots and `Allow for future` rules become agent-owned durable authority through the settings path. Interactive approval has no automatic timeout. |
| Credential broker | **Current** | Secrets remain encrypted or in configured runtime secret providers. Agents receive references or mediated action access, not the credential store. |
| `direct` execution | **Current** | Host permission and credential rails still apply, but there is no inner Claude SDK or Gantry OS sandbox. The host/container/VM is the confinement boundary. |
| `sandbox_runtime` | **Optional** | Adds outer whole-runner confinement. It is defense in depth, not a prerequisite for fleet topology and not a substitute for authorization. |
| Sandbox escape as a newly approved action | **Deferred** | A scoped retry after an OS-jail denial is recorded follow-up work; a sandbox approval does not currently imply an unsandboxed retry. |

The [permission lifecycle](./atlas/permission-execution.lifecycle.html) and
[runtime flows](./runtime-flows.md#permissioned-tool-execution) show the order
and terminal outcomes.

## Jobs, events, and delivery

| Feature family | Status | Current contract |
| --- | --- | --- |
| One-time, recurring, maintenance, and autonomous jobs | **Current** | Durable definitions, triggers, runs, leases, notification routes, setup state, tool activity, and terminal outcomes use the scheduler and Postgres coordination. |
| Atomic asynchronous task admission | **Current** | Repository adapters must atomically admit and claim bounded async work; unsafe count-then-create fallbacks are not supported. |
| Job-owned sessions | **Current** | Each job has its own session history and digest while sharing durable memory only through host-derived execution context. |
| Runtime events and control outbox | **Current** | Runtime events are durable observable facts. They do not carry continuation, stop, or prompt commands; those use the live-turn command inbox. |
| Outbound provider delivery | **Current** | The installed provider account supplies the delivery identity. Durable event/outbox evidence supports retry and partial-delivery reporting. |
| Host-owned job scripts | **Non-goal** | Scripts that bypass the governed runner and tool lifecycle are unsupported. Put work in the job prompt and grant semantic capabilities or narrow command authority. |

## Memory, dreaming, and company knowledge

| Feature family | Status | Current contract |
| --- | --- | --- |
| App/agent/subject memory | **Current** | Memory is isolated by app, agent, and `user`, `group`, `channel`, or `common` subject. Provider threads are routing/session metadata, not a new durable memory partition. |
| Lexical recall | **Current** | Always-on retrieval injects bounded, untrusted evidence once per inbound turn behind a session-identity fence. Memory content never grants instruction or tool authority. |
| Vector recall and embedding backfill | **Optional** | With OpenAI embeddings configured and ready vectors available, lexical and vector results are fused. Failure or budget exhaustion falls back to lexical; backfill pauses and resumes. |
| Memory dreaming | **Default off** | The scheduled system job stages and validates lifecycle proposals. Safe host-validated promotions may apply; destructive or contradictory changes wait in a durable review queue. |
| Company brain | **Current** | A separate app-scoped store holds pages, entities, graph edges, embeddings, and dream decisions for shared company knowledge. It does not collapse into personal/conversation memory. |
| Channel harvest into company brain | **Default off** | Each conversation must opt in with `brain_harvest: true`. Harvest currently rides conversations with an active installed-agent route. |
| Agent-less connector subscriptions | **Deferred** | Connector pollers that harvest sources without an installed agent are later work. |
| Hidden autonomous truth mutation | **Non-goal** | Model output is untrusted. Host validation and, where required, human review own durable mutation. |

See [Memory and Dreaming](../MEMORY.md) and
[Company Brain Core](./company-brain-core.md) for the distinct schemas and
review rules.

## Deployment and operations

| Feature family | Status | Current contract |
| --- | --- | --- |
| One binary, `all` role | **Current** | Workstation default: full control API, provider ingress, live execution, jobs, settings writes, and worker registration in one process. |
| `control`, `live-worker`, and `job-worker` roles | **Optional** | `GANTRY_PROCESS_ROLE` selects boot-time fleet lanes. The control role owns mutation authority; workers expose only ops/read-only diagnostics. |
| Workstation topology | **Current** | `settings.yaml` is a watched import/export copy; Postgres `settings_revisions` is durable authority. Local artifact bytes are allowed. |
| Fleet topology machinery | **Optional** | The shipped mechanism has a current limitation: Postgres leases, settings revisions, durable admission, role separation, and shared artifacts support the topology, but rate limits and LLM admission remain process-local; multi-instance deployment against one database must not ship until those authorities are made cluster-wide. |
| Horizontal live capacity | **Current** | Each live worker has `runtime.queue.max_message_runs` slots; adding workers adds potential live capacity after the cluster-authority limitation above is resolved. |
| Horizontal job capacity | **Current** | Job workers claim fenced leases and cluster slots. Provider quotas, database capacity, artifacts, and model limits remain external ceilings. |
| Locked support stack | **Optional** | A fleet variant uses locked presets and production posture for an internet-facing support deployment. |
| Hosted availability, SLA, or unlimited scaling guarantee | **Non-goal** | Gantry supplies coordination mechanisms, not an operations guarantee. The customer owns database, network, artifacts, identity, retention, and capacity engineering. |

For a role-by-role capacity and recovery guide, read
[Scaling and Deployment](./scaling-and-deployment.md). For exact operator
settings and readiness behavior, read
[Deployment Profiles](./deployment-profiles.md).

## Authority summary

When two surfaces appear to overlap, use this ownership rule:

| Question | Authority |
| --- | --- |
| What should the runtime run? | Latest compatible Postgres `settings_revisions` row; YAML is a workstation import/export copy. |
| Which process boots which subsystems? | Deployment environment `GANTRY_PROCESS_ROLE`, resolved once at boot. |
| Who owns a live turn or job? | Postgres claim, lease token, and fencing version. |
| May an action execute? | Host permission coordinator and durable reviewed authority, never the model alone. |
| Which credential is used? | Host credential broker and the selected provider account/model route. |
| What is conversation history? | Canonical Postgres conversation/message/session aggregates; provider artifacts are bounded adapter evidence. |
| What may be remembered? | App/agent/subject memory policy and host-validated lifecycle. |
| What is shared company knowledge? | The separate app-scoped company brain and its evidence/dream decisions. |
| What wakes a worker? | Notifications are hints; durable rows and claims remain truth. |
