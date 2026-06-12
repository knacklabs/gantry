# Gantry Components Overview

This document is for technical business owners. It explains what the Gantry runtime does, what each component contributes, and why the design choices matter without going deep into implementation details.

---

## 1. Gantry Runtime System

Gantry is an **agent runtime**: the host process that gives AI agents a controlled place to run, people or applications to respond to, tools to use, durable memory, and an audit trail. It is not just a chatbot, not just an LLM wrapper, and not a generic workflow engine.

The runtime sits between five worlds and brokers work between them:

- **Human chat surfaces**: Slack, Microsoft Teams, Telegram, plus a first-class web/SDK channel for in-product chat.
- **Customer applications**: backend services such as NestJS apps, Next.js apps, and workers that embed Gantry through the SDK.
- **Signed application events**: external systems such as CRMs, monitoring tools, and schedulers that push work in through scoped ingress credentials.
- **Approved business tools**: the actions an agent is permitted to use, such as internal APIs, databases behind approved connectors, browser automation with persistent profiles, CRM tools, and MCP-connected services.
- **Durable foundation**: Postgres-backed runtime state, secret providers, artifacts, and audit records.

Three abstractions make the runtime composable: **stateless agents** as versioned configurations, **scoped memory** tied to app/agent/conversation context, and a **flexible interaction surface** where the same runtime can serve realtime chat, async jobs, and application action requests.

---

## 2. Stateless Agents

An agent in Gantry is **a versioned configuration, not a permanently running bot**. When work needs to happen, the runtime spawns a fresh runner from the pinned configuration, executes the task, and tears the process down. The runner can still read explicit runtime state such as memory, jobs, and session context, but there is no hidden process memory quietly drifting between runs.

Four things attach to every agent:

- **Persona.** The agent's role and voice: developer, sales, research, operations, marketing, or personal assistant. Persona shapes tone and behavior, while capability policy decides what the agent can actually use.
- **Tools.** The actions an agent can use: send a message, query memory, browse a site, call an API, or use an approved connector. Tool access is catalogued, scoped, and policy-gated.
- **Skills.** Packaged bundles of instructions and workflow knowledge that teach an agent a procedure. "Triage a support ticket," "research a sales lead," and "summarize last quarter's metrics" are examples of skills an agent can be granted, swapped out, or revoked.
- **MCP servers.** Pluggable capability servers that speak the Model Context Protocol. Each server contributes its own toolset; agents can mount internal MCPs (built-in messaging, scheduling, browser, memory) or third-party MCPs with allowlists for which of their tools are exposed.

Browser is a first-class tool capability. When an agent is granted Browser, Gantry launches or reuses a host-managed browser profile for that agent's conversation, thread, or job context. That profile can keep normal browser state such as cookies and logged-in sessions across later runs, so a user does not have to repeat the same login every time the agent resumes work. The agent still does not receive raw passwords, choose arbitrary browser profile folders, or bypass approval policy.

When work starts, Gantry combines that frozen configuration with explicit runtime state: sessions, jobs, events, memory, and tool context.

**Why it matters:** because the agent is a configuration, the same product can ship several tightly scoped agents instead of one broad agent with too much authority. Capability changes are policy/config changes, not model rewrites. Auditors get a clear record of exactly what each agent was allowed to do at the moment it ran.

---

## 3. Providers, Conversations, and Threads

Gantry uses one neutral conversation model across Slack, Telegram, Teams, Web, and app-originated sessions. The agent runs against the conversation abstraction, while adapters handle provider-specific details.

The model has three levels:

- **Provider connection.** The credentialed link to an external system, such as a Slack workspace, Telegram bot, Teams tenant, or built-in app channel.
- **Conversation.** A top-level scope inside a provider: a Slack channel, Telegram DM, Teams chat, web session, or app conversation.
- **Thread or topic.** An optional sub-scope inside a conversation, such as a Slack thread, Telegram forum topic, or branched discussion.

The same agent definition can be bound to fifty conversations across four providers and behave correctly in each one.

**Why it matters:** the customer's experience stays native. Slack users stay in Slack. Teams users stay in Teams. Product users stay inside the product. The team writes the agent once instead of rebuilding it for every channel.

---

## 4. Security and Approval

The concept that shapes the entire runtime: **every conversation is its own security perimeter, and every tool call passes through a two-axis gate**: *who* is asking, and *what* is being asked. A message, SDK call, or signed ingress request never grants tool access by itself; policy does.

Four concepts, in order:

- **Per-conversation allowlist.** Each conversation binds an explicit list of users or app actors that are allowed to interact with the agent. The boundary lives in Gantry, not only in Slack, Teams, Telegram, or the customer app.

- **Per-conversation adminlist (approvers).** A separate list of users who can authorize risky actions. The allowlist answers "who can ask." The adminlist answers "whose approval counts when the agent needs permission."

- **Available tools vs allowed tools.** Tool access is two layers, not one.
  - *Available* = every tool the agent's configuration mounts: built-in tools, tools from skills, and tools exposed by connected MCP servers.
  - *Allowed* = the strict subset of those available tools that the agent is permitted to use *right now in this context*. Allowed is the intersection of the agent's configured policy, the conversation's policy, runtime decisions made by approvers, and any per-job allowlist. An agent can have a tool available and still be blocked from using it.

- **Runtime approval flow.** When the agent attempts a tool call that policy flags as risky, execution pauses. An approval request is posted into the conversation for the adminlist, and the approver picks one of three outcomes:
  - **Allow once** - single-use grant for this exact call.
  - **Always allow this rule** - adds a new rule to the conversation's policy so future calls of this shape pass automatically.
  - **Cancel** - deny.

  The decision is audit-logged and bound to the original tool call. The agent cannot grant itself approval.

Three foundational guarantees sit underneath this model: **multi-tenancy** for app-scoped records, **sandboxed execution** for risky work, and **credential isolation** so agents request named credentials without seeing raw secrets.

**Why it matters:** an agent that can do anything is a security incident waiting to happen. Gantry treats every risky action as something that needs named authority, scoped policy, and an audit trail. That is also why third-party systems can use ingress without receiving the customer's full Gantry API key.

---

## 5. Scoped Memory

In Gantry, **memory is scoped, not global**. A memory item is tied to the customer app, the agent, and the relevant subject such as a user, conversation, or thread. There is no shared global brain that quietly leaks information between customers, teams, or contexts.

The memory system has four important properties:

- **Boundaries.** Every memory record is keyed by the combination of the customer's app, the agent, the subject (user, conversation, or thread), and optionally the thread itself. The runtime physically cannot return a memory record across these boundaries; the boundary is enforced at the data layer, not asked nicely of the prompt.
- **Scopes.** When an agent is bound to a conversation, the binding chooses how wide the memory should be: a user, a thread, a whole conversation, an agent's footprint inside the app, or app-wide common knowledge.
- **Kinds.** Memory is typed: preferences, decisions, facts, corrections, constraints, references, procedures. Each kind has its own lifecycle rules: a preference might decay slowly, a correction supersedes the fact it corrects, and a constraint is sticky until explicitly revoked.
- **Evidence.** Every durable memory record points back to the raw evidence: the original message, tool output, or human input that created it. Memory is auditable. A customer can ask "why does the agent think I prefer X?" and get a real answer.

**Why it matters:** privacy and trust are the gating concern in B2B AI. A customer's agent cannot accidentally surface knowledge from another customer's workspace because the wrong records are outside the query boundary.

---

## 6. Memory Dreaming

Memory is not a passive store. Gantry uses background **dreaming** cycles to turn raw conversational evidence into curated, higher-confidence durable memory and to identify what no longer applies.

Three stages run in sequence:

- **Light sleep.** The runtime sweeps recent evidence (messages, tool outputs, user corrections) and proposes candidate memories. Candidates start staged; they are not yet durable.
- **REM.** The runtime cross-checks candidates against existing memory and flags contradictions. If the user said X yesterday and not-X today, that conflict is surfaced rather than silently overwritten.
- **Deep sleep.** High-confidence candidates can be promoted into durable memory. Low-confidence or contradicted candidates are held back. Duplicates can be merged. Obsolete facts can be retired.

A **review gate** sits over destructive or sensitive memory changes. Retiring an existing fact, rewriting memory, or merging records can erase information, so those actions must be policy-gated instead of silently applied.

**Why it matters:** every agent product eventually hits the "remember things across sessions" wall. Dumping every message into a vector database creates stale and contradictory memory. Gantry treats memory as a lifecycle, not a bucket.

---

## 7. Jobs and Runtime Events

A **job** is a unit of agent work that is scheduled or triggered, scoped to a specific conversation, thread, or application context. Where a session is usually interactive, a job lets the agent do work asynchronously and report back.

Each job has:

- A **target conversation or thread**, which determines whose memory it reads, whose context it inherits, and where its output naturally lands.
- An **agent and a prompt**, which define what work to do.
- A **schedule**: manual, one-shot at a future time, recurring on a cron, or fixed-interval.
- An **execution mode**: parallel runs allowed, or strictly serialized so a long-running job never overlaps itself.
- **Notification routes**, which let the result fan out to chat, webhook delivery, or other configured destinations.

Jobs can be triggered by the SDK, by a schedule, by a conversation request, or by an external system pushing a signed event into the ingress API.

During the run, the agent may use approved tools: internal app APIs, databases behind approved connectors, persistent browser profiles, and MCP connectors. Progress is published as **runtime events** that can be observed through the configured integration paths such as chat delivery, session event streams, webhooks, and SDK wait calls.

**Why it matters:** the same agent that answers questions in chat can run scheduled work, preserve the right context, and report back where the work belongs. That turns the agent from a chat-only assistant into an operating layer for real business workflows.

---

## 8. SDK Control Plane

The Gantry SDK is the **server-side client for products that embed Gantry**. NestJS services, Next.js routes, background workers, and scripts all reach the runtime through the same surface, with the same authentication model and the same response contracts. There is no hidden, internal-only API.

Conceptually, the SDK exposes several API families:

- **Sessions.** Open a conversation, send messages, list past events, stream new events as they happen, and wait for the agent to finish responding.
- **Jobs.** Create scheduled or manual jobs, list and inspect them, trigger one on demand, pause and resume, and wait for a triggered job's result.
- **Agents.** Define and version agents, attach skills, mount or revoke MCP servers, and bind agents to conversations.
- **Memory.** Save a memory record, search by context, patch or delete a record, and inspect or trigger memory workflows where enabled.
- **Webhooks.** Register outbound delivery destinations with HMAC-signed payloads, test them, list deliveries, replay failures, or purge a dead-letter queue.
- **Ingresses.** Issue and rotate signed credentials that let an external system push events into the runtime without holding a full API key.

The customer's **trusted backend** holds the Gantry API key. Browsers, mobile apps, and partner integrations talk to that backend, never directly to Gantry. This keeps the security model simple: one trusted boundary, one set of credentials to manage.

**Why it matters:** Gantry is not a SaaS chatbot product. It is a runtime that can be embedded into the customer's own product. The SDK gives product teams one mental model, one auth model, and one set of contracts.

---

## 9. Three Interaction Patterns

Gantry supports three product patterns. They are not alternatives; most real products use all three, and they share the same agent runtime, memory, policy, and event model.

- **Realtime chat through a trusted product backend.** A user types in a chat UI; the customer's backend opens a session, sends the message, and streams the agent's response back to the user over Server-Sent Events or another customer-owned UI fanout path.

- **Async jobs from schedules or external systems.** A schedule, CRM, monitoring tool, or backend service fires a scoped request that triggers a job. The caller can get a trigger ID immediately, wait through the SDK, or rely on a configured webhook when the result is ready.

- **Application action requests.** A product sends a plain-language instruction such as "draft a follow-up for this lead" or "summarize the last 24 hours of incidents." The agent can act through approved tools, but only inside the selected capability and policy boundary.

All three patterns hit the same security gate, the same scoped memory, and the same audit trail.

**Why it matters:** real products mix conversational, event-driven, and instructional flows. A support tool might use chat for a human operator, a background job to summarize a ticket every few hours, and an admin button to ask the agent to draft a reply. Gantry keeps those patterns on one runtime instead of three separate systems.

---

## 10. Realtime Integration Paths

For outside applications, the **trusted backend holds the Gantry key**. Browsers, mobile clients, and partner systems do not. Everything that crosses the trust boundary is signed.

The trusted backend has four integration channels available to it:

- **Runtime events (SSE).** A long-lived event stream of typed, numbered events. The backend can consume it and forward updates to its own web UI, dashboard, or analytics pipeline. Clients that disconnect can reconnect from the last event they saw.
- **Outbound webhooks.** HMAC-signed POSTs to a URL the customer has registered. Fire-and-forget: the runtime retries on failure, surfaces persistently failing endpoints in a dead-letter queue, and gives the customer tools to inspect, replay, or purge those deliveries. Best for backend-to-backend integrations where the receiver is its own server.
- **Inbound signed ingress.** External systems push events *into* Gantry over signed inbound endpoints, scoped to allowed session messages, job triggers, or job templates. Each ingress has its own rotatable secret, so a customer can give a third-party vendor a narrow credential instead of a full API key.
- **Approved app tools.** Through any of the above, an action request can ask the agent to use approved tools: an internal app API, a database connector, a persistent browser profile, a CRM, or an MCP-connected service. The selected capability policy and runtime approval flow still decide which tools the agent may actually use.

**Why it matters:** most agent platforms force one delivery model, such as chat-only streaming or webhook-only integrations. Gantry lets the same runtime handle realtime observation, backend callbacks, inbound events, and approved tool actions without architectural rework.

---

## 11. End-to-End Story

A single story that touches every component:

1. A **sales agent** is configured with a sales persona, an outreach skill, messaging tools, and a CRM connector.
2. A new high-value lead lands in the customer's CRM. The CRM fires a signed event into a scoped **ingress** endpoint locked down to one specific job in one specific Slack channel.
3. The runtime validates the signature and checks that the ingress is allowed to trigger that work. A **job** is enqueued, scoped to the deal team's Slack channel.
4. A fresh runner spawns. It reads the conversation's **scoped memory**: past discussion about this account, standing constraints, and the team's stated preferences for outreach style.
5. The agent uses its **approved tools** to gather public context, including the same persistent browser profile if this workflow needs a logged-in web session. It then attempts to write a note back into the CRM. That tool call is policy-flagged as risky, so execution **pauses** and an approval request is posted into the Slack channel for the **adminlist**.
6. The sales lead, who is on the adminlist, chooses **Always allow this rule**. The agent finishes the CRM write and posts a tailored research brief into the Slack channel. At the same time, an **outbound webhook** can notify the customer's analytics pipeline, and a dashboard can render progress live over **SSE**.
7. Later, a **dreaming** cycle can promote useful evidence into durable memory. The next time the agent works this account, it starts from a smarter baseline. The whole flow is visible in the audit trail.

That is the core value: one runtime for embedded AI work that is connected, controlled, observable, and reusable. None of the components require the customer to know how the others work.
