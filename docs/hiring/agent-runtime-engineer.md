# Software Engineer — Agent Runtime & Platform

**Team:** Core Runtime · **Location:** Remote / Hybrid · **Level:** Mid–Senior (flexible)

## About Gantry

Gantry is the runtime that makes AI agents trustworthy in production. It's the
infrastructure layer that sits between people (Slack, Teams, Telegram, web),
backend applications (via SDK), and the tools agents use to get work done
(browsers, CLIs, MCP servers, skills, databases). Think of it as the launch
gantry for AI agents — it fuels them, runs diagnostics, enforces permissions,
keeps a complete audit trail, and handles the operational housekeeping so the
agent can focus on solving problems.

We are not a chatbot or an LLM wrapper. We build the durable, secure, observable
runtime that lets autonomous agents operate safely on real systems. The people
who build this runtime are, themselves, heavy daily users of coding agents — we
expect you to be too.

## What you'll work on

You'll own slices of the runtime that turn a single inbound message into a safe,
audited agent run and back again. Depending on your strengths, that includes:

- **Runtime orchestration** — the message loop, per-conversation queueing and
  ordering, crash recovery, agent spawning, and process lifecycle.
- **Capability & permission systems** — the tiered model that decides *who* can
  ask an agent to do *what*, including approval gates, denylists, sandboxing, and
  the reviewed manifests through which agents gain new skills, tools, and MCP
  servers.
- **Agent harness & tool surface** — the layer that assembles an agent's context,
  system prompt, and available tools; routes tool calls through host-owned gates;
  and streams results back safely.
- **Channel integrations** — provider-neutral adapters that normalize Slack,
  Teams, Telegram, and SDK events into one canonical message model.
- **Memory & background lifecycles** — subject-scoped durable memory, semantic +
  lexical recall, and the background pipelines that curate and promote
  high-confidence facts.
- **Control plane & SDK** — the HTTP/SSE API and public client that let backend
  apps drive agents, deliver webhooks, and coordinate work.
- **Scheduling & jobs** — durable job definitions, triggers, and queue-backed
  background execution.

## Mandatory requirements

These are non-negotiable for this role:

- **You use coding agents every day.** You ship real work with tools like Claude
  Code, Cursor, Codex, or equivalents — and you have opinions about where they
  help and where they don't. We build for agent users, so you must *be* one.
- **You understand how agent harnesses actually work.** The full loop — system
  prompt and context assembly, the tool-use / function-calling cycle, multi-tool
  orchestration, sub-agents, retries, guardrails, and how a harness streams and
  gates model output. You can reason about it, debug it, and extend it, not just
  call an API.
- **Solid backend engineering in a typed language** (we use **TypeScript /
  Node.js**): async patterns, event-driven design, and the ability to reason
  about runtime performance.
- **Experience designing and operating production services with real
  persistence** — schemas, migrations, queues, background workers (we run
  **PostgreSQL** + a job queue).
- **A security and correctness mindset** — you think in trust boundaries, least
  privilege, failure modes, and audit-ability by default. This matters acutely
  when the thing executing your code is an autonomous agent.

## Nice to have (any subset)

- Familiarity with the **Model Context Protocol (MCP)** or the Anthropic / Claude
  Agent SDK; experience building or publishing **agent skills or tools**.
- Building **provider integrations** (Slack, Telegram, Teams, webhooks) or other
  event-normalization layers.
- Distributed-systems concerns: idempotency, ordering, recovery,
  exactly-/at-least-once delivery.
- Browser automation (Playwright), vector/semantic search (pgvector), or
  ORM-based data layers (Drizzle).
- Care for **clean architecture** — strict layering, ports-and-adapters, keeping
  a core runtime lean rather than letting it sprawl.

## How we work

- We build with coding agents and dogfood our own runtime — fluency with these
  tools is part of the job, not a side skill.
- New capabilities ship as **scoped skills or packages**, not as bloat in the
  core runtime.
- Strict layering: domain logic never reaches into adapters or provider-specific
  code.
- We value surgical changes, tests that pin behavior, and surfacing tradeoffs
  early over moving fast and breaking trust boundaries.

## Why it's interesting

Agent runtimes are a brand-new category of infrastructure. The hard problems —
safe autonomy, durable state, permissioning, observability — don't have settled
answers yet. You'll help define them, using the very tools you're helping to
build a home for.
