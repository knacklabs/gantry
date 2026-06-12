# Senior Software Engineer, Agent Runtime & Platform

**Team:** Core Runtime · **Location:** Hybrid · **Level:** Senior

## About Gantry

Gantry is an enterprise agent runtime. It is the host process that gives AI
agents a controlled place to run, people and applications to respond to, tools
to use, durable memory, and an immutable audit trail. A launch gantry holds a
rocket upright, fuels it, runs diagnostics, and swings away at launch. It does
everything except fly, and it exists so the rocket can. Gantry plays the same
role for AI agents.

The runtime brokers work between five worlds: human chat surfaces (Slack,
Microsoft Teams, Telegram, and a web channel), customer backend applications
through an SDK, signed external events from third party systems, approved
business tools (connectors, browser automation, scoped CLIs, internal APIs),
and a durable foundation for state, secrets, artifacts, and audit.

Gantry is not a chatbot and not an LLM wrapper. It is the layer that makes
autonomous agents safe to run against real systems.

## What you'll work on

You will own slices of the path from an inbound message to a safe, audited
agent run and back, along with the surfaces that let humans govern it.

- **Runtime orchestration.** Message queueing and ordering per conversation,
  agent spawning and process lifecycle, crash recovery, and resuming runs that
  were interrupted.
- **The boundary between host and agent.** The authenticated channel between
  the runtime and the agent process it supervises, and the sandbox that risky
  tool execution runs inside. The host treats the agent as untrusted, and
  keeping that boundary sound as capabilities grow is permanent core work.
- **Multi-harness execution.** A neutral execution boundary that lets agent
  harnesses ship as adapters. You will help build the abstraction that keeps
  permissions, sandboxing, streaming, sessions, and audit owned by the runtime
  no matter which harness sits underneath.
- **Sandboxed execution at scale.** Enforcing, fail-closed OS sandboxes around
  agent runs, with audited egress and resource caps, and evolving the runtime
  from a single host to a distributed execution plane through the same
  provider-neutral seam without weakening the security model.
- **Admin console and API.** The management UI and public API that admins use
  to create and configure agents, grant and revoke capabilities, review
  approvals, and inspect the audit trail. This work is equal parts product and
  platform.
- **Capability and permission systems.** The model that decides who can ask an
  agent to do what: reviewed and scoped grants, layered approval flows, and an
  audit trail behind every decision.
- **Memory and continuity.** Durable, scoped agent memory with hybrid recall,
  session continuity, and background pipelines that curate and promote facts
  with auditable evidence.
- **Channels, ingress, and jobs.** Normalization of chat platforms into
  canonical conversation concepts, signed inbound events from external
  applications, and durable scheduled jobs with capability-gated execution.

## Requirements

- **You use coding agents every day.** You ship real work with tools like
  Claude Code, Codex, or Cursor, and you have formed opinions about where they
  help and where they fail. We develop with agents and dogfood our own
  runtime, so being a power user is part of the job.
- **You understand agent harnesses from the inside.** You have shipped
  production systems on top of a serious harness such as the Claude Agent SDK,
  deepagents, or the OpenAI Agents SDK, deeply enough that you can extend and
  debug the loop itself: context assembly, the tool use cycle, permission
  callbacks, streaming, subagents, and session resume.
- **You are a senior backend engineer in a typed language**, fluent in async
  and event-driven patterns, process lifecycle, and performance work. Our
  runtime is TypeScript on Node.js. Deep experience in an adjacent typed
  ecosystem works if you are willing to go deep on ours.
- **You have run production systems with real persistence**: relational
  schemas, migrations, transactions, queues, background workers, and a clear
  answer for what happens when the process dies in the middle of a write.
- **You think in trust boundaries**: least privilege, fail-closed defaults,
  signed boundaries, sandboxed execution of untrusted code, and audit. These
  matter even more when the thing driving your code is an autonomous model.
- **You ramp on large, unfamiliar codebases quickly**, using search, tests,
  and architecture docs to find the right seam in hours, and you can ship a
  tested change without needing the whole system explained first.

## Strong candidates may also have

- Written their own agent harness, or integrated more than one harness or
  model provider behind a common abstraction.
- Built or published MCP servers, agent skills, or tools.
- Shipped admin or developer facing products such as management consoles,
  permission UIs, or public APIs with versioned contracts.
- Worked hands on with sandboxing and process isolation (OS isolation
  primitives, containers, microVMs), or built systems where part of the
  process tree is untrusted.
- Distributed systems experience: idempotency, ordering, leases, delivery
  guarantees, and recovery after crashes.
- Used hexagonal architecture (ports and adapters) at scale, keeping a core
  runtime lean while the adapter surface grows.

## How we work

- We develop with coding agents under a structured workflow: plan, decompose,
  implement, test, review. Deterministic verification gates plus quality,
  security, and performance reviews run before every merge.
- Layering is enforced. Domain code never imports providers, adapters
  implement ports, and risky tool execution always routes through
  deterministic permission evaluation.
- New capabilities ship as reviewed, scoped definitions rather than additions
  to the core runtime.
- We are early stage. We delete legacy code instead of shimming it, and every
  meaningful change states its blast radius.
- We value surgical diffs, tests that pin behavior, and tradeoffs surfaced
  before implementation.

## Why it's interesting

Agent runtimes are a new category of infrastructure, and the hard problems do
not have settled answers yet: safe autonomy, durable state, permissions that
survive hostile model output, multi-harness execution, scaling sandboxed runs
from one host to a fleet, and memory that improves without leaking. You will
help define those answers in production code, using the same tools you are
building a home for.
