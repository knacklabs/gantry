# Gantry architecture source evidence

This manifest is the provenance layer for the architecture atlas. It records what was inspected, which source revision the diagrams describe, and how current implementation was separated from historical intent.

> Source snapshot: Gantry `69ac5b7` (`69ac5b71650d1d8ff99c24eb15fa368b9c3eb418`). Runtime behavior is derived from current source and accepted decisions. Historical prompts and audits remain context, not current authority.

## Evidence policy

The atlas uses this authority order:

1. current production source and public contracts at the pinned revision;
2. accepted architecture decisions, especially decisions 0006, 0007, 0018, 0019, 0023, 0025, 0027, 0028, 0040, 0043, 0056, 0068, 0074, 0077, 0082, 0085, 0087, 0089, 0090, 0094, 0097, 0099, 0102, and 0103;
3. current architecture and operator guides;
4. tests as executable examples of invariants;
5. goal prompts, audits, handoffs, and superseded decision sections as historical context only.

The repository contains valuable historical records. This atlas does not rewrite them or silently promote an earlier proposal to current behavior.

## Snapshot and generator

| Item | Value |
| --- | --- |
| Gantry repository | `https://github.com/knacklabs/gantry` |
| Gantry revision | `69ac5b71650d1d8ff99c24eb15fa368b9c3eb418` |
| Archify repository | `https://github.com/tt-a1i/archify` |
| Archify version | `2.13.0` |
| Quality profile | `showcase` |
| Delivery evidence | [delivery-receipts.json](delivery-receipts.json) |

## Subsystem evidence map

| Concern | Primary implementation evidence | What it establishes |
| --- | --- | --- |
| Process bootstrap | [`startup.ts`](../../../apps/core/src/app/bootstrap/startup.ts), [`runtime-app.ts`](../../../apps/core/src/app/bootstrap/runtime-app.ts), [`fleet-boot.ts`](../../../apps/core/src/app/bootstrap/fleet-boot.ts) | One binary can run `all`, `control`, `live-worker`, or `job-worker`; role surfaces and provider boot are selected at startup. |
| Runtime assembly | [`runtime-services.ts`](../../../apps/core/src/app/bootstrap/runtime-services.ts) | Application services, repositories, adapters, settings, jobs, memory, credentials, and execution lanes are composed at the host boundary. |
| Channel providers | [`register-builtins.ts`](../../../apps/core/src/channels/register-builtins.ts), [`channel-provider.ts`](../../../apps/core/src/channels/channel-provider.ts) | Slack, Telegram, Teams, Discord, and app surfaces implement a provider boundary rather than embedding channel behavior in the agent loop. |
| Provider accounts and conversations | [`conversation-administration-service.ts`](../../../apps/core/src/application/provider-conversations/conversation-administration-service.ts), [`live-turn-routing.ts`](../../../apps/core/src/runtime/live-turn-routing.ts) | Credentials are provider-account scoped; conversations bind sender policy, approvers, installed agents, triggers, and delivery identity. |
| Durable ingress | [`conversation-message-ingress.ts`](../../../apps/core/src/application/external-ingress/conversation-message-ingress.ts), [`group-processing-flow.ts`](../../../apps/core/src/runtime/group-processing-flow.ts) | Provider input is normalized, scoped, and persisted before execution side effects. |
| Live admission and fencing | [`live-turn-authority.ts`](../../../apps/core/src/runtime/live-turn-authority.ts), [`live-turn-lease-service.ts`](../../../apps/core/src/application/live-turns/live-turn-lease-service.ts), [`live-admission-work-loop.ts`](../../../apps/core/src/runtime/live-admission-work-loop.ts) | One active turn per durable scope, bounded run slots, leases, generations, and stale-owner fencing coordinate a live fleet without a central admission process. |
| Recovery and commands | [`live-turn-recovery.ts`](../../../apps/core/src/runtime/live-turn-recovery.ts), [`live-turn-command-pump.ts`](../../../apps/core/src/runtime/live-turn-command-pump.ts) | A singleton recovery sweep reclaims abandoned work; durable commands and fencing control active owners. |
| Agent execution | [`agent-execution-adapter.ts`](../../../apps/core/src/application/agent-execution/agent-execution-adapter.ts), [`agent-execution-adapter-registry.ts`](../../../apps/core/src/application/agent-execution/agent-execution-adapter-registry.ts), [`group-agent-runner.ts`](../../../apps/core/src/runtime/group-agent-runner.ts) | Harness selection is provider-neutral; DeepAgents and Claude Agent SDK execution sit behind a host-owned adapter contract. |
| Model access | [`gantry-model-gateway.ts`](../../../apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts), [`gantry-model-gateway-routing.ts`](../../../apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway-routing.ts) | Runners use a loopback gateway and short-lived Gantry token while the trusted host injects approved provider authentication and records usage. |
| Credentials | [`agent-credential-service.ts`](../../../apps/core/src/application/credentials/agent-credential-service.ts), [`agent-credential-broker-factory.ts`](../../../apps/core/src/adapters/credentials/agent-credential-broker-factory.ts) | Real credentials remain encrypted and host-owned; agents receive references or mediated access, not the durable secret store. |
| Permission order | [`permission-management-service.ts`](../../../apps/core/src/application/permissions/permission-management-service.ts), [`tool-gate-core.ts`](../../../apps/core/src/runner/tool-gate-core.ts), [`permission-decision-coordinator.ts`](../../../apps/core/src/runtime/permission-decision-coordinator.ts) | Hard deny, deployment constraints, authority mode, deterministic rails, optional advice/cache, and human review remain separate authority layers. |
| Sandboxing | [`runner-sandbox-provider.ts`](../../../apps/core/src/adapters/sandbox/runner-sandbox-provider.ts), [`sandbox-runtime-runner.ts`](../../../apps/core/src/adapters/sandbox/sandbox-runtime-runner.ts) | Direct compatibility and outer `sandbox_runtime` are explicit deployment choices; the safe-host boundary is not implied by a model prompt. |
| Capability surfaces | [`capability-runtime-access.ts`](../../../apps/core/src/shared/capability-runtime-access.ts), [`gantry-mcp-tool-surface.ts`](../../../apps/core/src/runner/gantry-mcp-tool-surface.ts) | Tools, skills, MCP servers/actions, browser, files, messaging, scheduler, memory, brain, and admin surfaces are inventoried and permissioned capabilities. |
| Durable settings | [`settings-revision-listener.ts`](../../../apps/core/src/runtime/settings-revision-listener.ts), [`settings-revision-repository.postgres.ts`](../../../apps/core/src/adapters/storage/postgres/repositories/settings-revision-repository.postgres.ts) | Postgres settings revisions are fleet authority; workers consume ordered desired-state updates instead of independently treating local files as truth. |
| Jobs | [`scheduler.ts`](../../../apps/core/src/jobs/scheduler.ts), [`execution-runtime-events.ts`](../../../apps/core/src/jobs/execution-runtime-events.ts) | One-time, recurring, maintenance, and autonomous work run through durable scheduling and runtime-event evidence. |
| Runtime events and delivery | [`runtime-event-forwarding.ts`](../../../apps/core/src/runtime/runtime-event-forwarding.ts), [`event-bus-outbox-boundary`](../../decisions/0016-event-bus-outbox-boundary.md) | Runtime facts and outbound effects use durable event/outbox boundaries so delivery and recovery remain inspectable. |
| App memory | [`MEMORY.md`](../../MEMORY.md), [`memory-dreaming-runner.ts`](../../../apps/core/src/runtime/memory-dreaming-runner.ts), [`memory-timeouts.ts`](../../../apps/core/src/runner/memory-timeouts.ts) | Evidence becomes scoped candidates and active memory; lexical recall is baseline, vector recall is optional, and dreaming produces host-validated proposals. |
| Company brain | [`brain-runtime.ts`](../../../apps/core/src/brain/brain-runtime.ts), [`brain-channel-harvest.ts`](../../../apps/core/src/brain/brain-channel-harvest.ts) | App-scoped pages, entities, edges, embeddings, and dream decisions form a separate knowledge system; channel harvest is default-off and conversation opt-in. |
| Control API | [`index.ts`](../../../apps/core/src/control/server/index.ts), [`openapi.ts`](../../../apps/core/src/control/server/openapi.ts) | Agents, conversations, runs, sessions, settings, jobs, credentials, memory, brain, models, capabilities, webhooks, usage, and system health have a programmatic control surface. |
| Static and shared artifacts | [`remote-first-skill-artifact-store.ts`](../../../apps/core/src/adapters/artifacts/skills/remote-first-skill-artifact-store.ts), [`local-file-artifact-bytes.ts`](../../../apps/core/src/adapters/artifacts/files/local-file-artifact-bytes.ts) | Workstation storage can be local; workers that may claim the same fleet workload need shared artifact visibility. |

## Claims deliberately not made

- No hosted, multi-tenant Gantry SaaS is implied. Each organization operates its own workstation or fleet.
- No throughput number, customer count, return-on-investment percentage, certification, compliance status, SLA, or availability guarantee was inferred from source.
- Horizontal capacity does not remove provider quotas, database capacity, artifact-store bandwidth, or single-consumer constraints such as bot polling ownership.
- Process isolation, application scope, agent scope, and conversation scope are real boundaries, but they are not presented as a substitute for an organization's broader identity, network, retention, and compliance controls.

## Reproducing the diagrams

Each typed JSON file is the reviewable source. Each HTML file is a self-contained Archify delivery. The receipt records exact SHA-256 hashes, automated validation, and the separately performed visual review. Re-delivering a diagram changes its artifact hash even when its conceptual content appears similar, so both files and the receipt must be updated together.
