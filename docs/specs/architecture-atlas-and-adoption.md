---
slug: architecture-atlas-and-adoption
title: Source-derived architecture atlas and company adoption guide
status: confirmed
saved: 2026-08-03T10:17:20+00:00
---

# Source-derived architecture atlas and company adoption guide

## Capability

Gantry provides one source-derived, layered documentation experience that lets a company evaluator understand why the platform exists, an operator deploy and scale it, and a developer trace real runtime behavior from entrypoint to durable state without relying on historical goal prompts or manually edited architecture diagrams.

## Audiences and outcomes

- Company evaluators can identify the problems Gantry solves, its differentiators, ideal and poor-fit use cases, operational responsibilities, security posture, adoption path, and measurable value hypotheses without unsupported market claims.
- Operators can progress from a single workstation runtime to a role-separated fleet and understand settings authority, credentials, provider accounts, conversations, readiness, recovery, and scaling limits.
- Developers can trace the code-backed control, execution, provider, storage, memory, permission, job, event, SDK, and observability boundaries from a stable reading order.
- Architects can inspect verified interactive diagrams whose typed source and source-evidence revision are committed beside the generated HTML.

## Documentation contract

The public documentation must provide:

1. A documentation/architecture landing page that routes readers by audience and experience level.
2. A source-derived system atlas describing current behavior at a pinned Gantry commit, including explicit current-vs-planned labels.
3. A complete feature catalog covering:
   - agents, agent runtimes, harnesses, models, subagents, and callable agents;
   - provider accounts, conversations, threads, installs, multi-agent and multi-conversation routing;
   - Slack, Telegram, Teams, Discord, app/SDK, external ingress, and outbound webhook surfaces;
   - capabilities, skills, tools, MCP, browser, attachments, sandboxing, credentials, permissions, audit, and identity;
   - live turns, sessions, continuation, recovery, jobs, async work, runtime events, and delivery;
   - scoped memory, extraction, lexical/semantic recall, memory dreaming/review, company brain, brain dreaming, and observer boundaries;
   - CLI, Control API, Node SDK, direct LLM API, settings desired state, Postgres, pg-boss, artifacts, telemetry, health, and deployment.
4. End-to-end explanations for at least: inbound live message, scheduled job, permission decision, memory evidence-to-recall/dreaming, and fleet recovery/scaling.
5. A basic-to-advanced learning and adoption path, including setup prerequisites, first agent, first provider conversation, adding agents/conversations, adding tools/MCP/browser, enabling memory, adding jobs/API integrations, production hardening, and fleet scaling.
6. A company adoption guide with benefits, trade-offs, use-case patterns, rollout phases, stakeholder responsibilities, evaluation criteria, and honest non-goals.

## Archify contract

Use Archify v2.13 from `tt-a1i/archify` to create a bounded set of showcase-quality artifacts rather than one unreadable mega-diagram:

- system context and runtime architecture;
- live message/agent execution sequence;
- memory, dreaming, and company-brain data flow;
- permission/tool execution lifecycle;
- fleet deployment and horizontal execution architecture.

Each artifact must:

- use fresh Gantry-specific stable IDs and terminology;
- commit typed JSON source and self-contained interactive HTML;
- record the Gantry repository revision used as evidence;
- pass Archify `validate` and final `deliver` at `--quality showcase` with all showcase checks and no warnings;
- stay truthful to authored relationships and avoid claiming unimplemented infrastructure;
- keep source links revision-pinned when source evidence is used;
- remain usable as a static GitHub-hosted file without a server runtime.

## Truth and positioning constraints

- Current runtime behavior comes from code and accepted decisions; historical prompts, audits, superseded decisions, and roadmap items are context, not current authority.
- Gantry is a self-hosted provider-neutral runtime, not a hosted multi-tenant Gantry SaaS control plane.
- Horizontal scaling means independent control, live-worker, and job-worker process roles within a customer's fleet, backed by Postgres coordination, durable leases/fences, and shared artifacts.
- App, agent, provider-account, conversation, thread, run, and memory scopes must not be collapsed into generic “tenant” claims.
- The company pitch may explain value and evaluation metrics, but must not invent ROI percentages, benchmark numbers, compliance certifications, customer counts, or availability guarantees.
- Planned or deferred features must be labeled clearly and must not appear in current-feature lists.
- Historical architecture and decision records retain their meaning; the atlas links to them and does not rewrite their historical claims.

## Acceptance criteria

1. A new reader can choose an evaluator, operator, developer, or architect path from the documentation entrypoint and reach the relevant deep guide in one click.
2. The architecture atlas identifies current process roles, execution lanes, authority boundaries, durable stores, trust boundaries, and provider/application surfaces with source paths.
3. The feature catalog includes every feature family listed in this spec and distinguishes current, optional, experimental/default-off, deferred, and non-goal behavior.
4. Multi-agent documentation proves both directions: one agent across multiple conversations and multiple agents/provider accounts in one provider conversation, including independent credentials, approvers, triggers, memory/session identity, and delivery routing.
5. Scaling documentation explains the workstation-to-fleet progression, per-worker live capacity, durable one-active-turn-per-scope serialization, job leases/fencing, provider inbound single-consumer cases, recovery coordinator scope, settings revision propagation, and shared artifact requirements.
6. Memory documentation distinguishes scoped memory from company brain and explains extraction, evidence, lexical fallback, optional vector recall, dreaming proposals, host validation, human review, audit rows, and prompt-injection boundaries.
7. Security documentation preserves the host-owned permission order, credential broker boundary, direct vs sandbox-runtime distinction, protected capability rules, control approvers, and audit behavior.
8. The adoption guide includes ideal-fit/poor-fit guidance, stakeholder map, phased rollout, production checklist, evaluation metrics, and trade-offs without unsupported claims.
9. Five Archify JSON/HTML artifact pairs pass showcase validation and final delivery with zero warnings; their source revision matches the documented Gantry commit.
10. Root and docs indexes link the new material without breaking existing documentation paths or changing the historical meaning of decisions/audits.
11. A deterministic internal-link check reports zero broken local documentation links in the changed/current public-doc scope.
12. No runtime source, API, schema, settings behavior, or package contract changes are introduced.

## Non-goals

- Rewriting every historical goal prompt, audit, handoff, measurement, or decision record.
- Adding runtime features, hosted infrastructure, a documentation framework, or a generated API reference system.
- Claiming production readiness, compliance, benchmarks, or customer proof not established by repository evidence.
- Replacing subsystem docs that already provide accurate implementation detail; the atlas should organize and cross-link them.
