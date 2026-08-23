# Company adoption guide

> Run governed AI agents where your teams already work—on infrastructure and credentials you control.

Gantry is self-hosted agent infrastructure, not a hosted multi-tenant Gantry
cloud. Each organization operates its own workstation or fleet deployment and
owns its model, channel, data, and operational boundaries.

Gantry is a customer-operated agent runtime for teams that need model work to
cross real product, channel, tool, memory, and scheduling boundaries without
handing those boundaries to a model provider. This guide is an evaluation
framework, not a promise of outcomes. Use it to decide whether Gantry fits,
what your organization must still own, and how to learn through evidence
before expanding its role.

## Start with fit

### Gantry is a strong candidate when

- your agents must work in existing channels or behind an application API;
- the host, rather than a prompt or provider SDK, must own credentials,
  permissions, capability projection, durable state, and audit records;
- you need provider-neutral model aliases or channel adapters so application
  logic does not depend on one vendor;
- conversations, scheduled jobs, memory, and human approvals need one runtime
  authority; or
- you are prepared to operate Node.js, Postgres, secrets, networking, backups,
  monitoring, and incident response in your own environment.

### Gantry is a poor fit when

- you want a hosted service that operates the control plane for you;
- a stateless chatbot wrapper or a single provider SDK already satisfies the
  problem;
- you need a general workflow engine rather than scheduled agent work;
- you cannot own production security and operations; or
- you require a certification, SLA, regional failover, published benchmark,
  or unrestricted multi-instance scale that this project does not claim.

## Advantages and trade-offs

| What Gantry gives you | What your team accepts or owns |
| --- | --- |
| One host boundary for channel ingress, execution, permissions, credentials, memory, and delivery | More platform surface than a direct model API integration |
| Provider-neutral model and execution adapters | Provider behavior and parity still differ behind those adapters |
| Durable Postgres records for conversations, runs, jobs, settings, memory, leases, and audit | Database operations, migration discipline, retention, backup, and restore |
| Reviewed capabilities and mediated secrets instead of raw credentials in agent workspaces | Capability design, least-privilege policy, approval ownership, and secret-provider operations |
| A workstation-to-role-separated deployment path using the same binary | Shared artifact storage and cluster authority work before unrestricted multi-instance production use |
| SDK, Control API, signed ingress, webhooks, and channel adapters around the same runtime | API-key scope, network exposure, provider account ownership, and integration testing |

These are architectural properties, not evidence that Gantry will reduce cost,
increase productivity, or meet a particular throughput target in your
environment. Measure those outcomes in your own workload.

## Representative use cases

- A team assistant in Slack, Teams, Telegram, or Discord that can use reviewed
  tools and preserve scoped memory.
- An application feature that creates sessions and sends work through
  `@gantry/sdk` or the authenticated Control API.
- A scheduled research, triage, or reporting agent whose runs and delivery
  evidence must survive process restarts.
- Several agents in one native conversation, each using its own Provider
  Account and explicit Conversation Install.
- One agent installed into several conversations while delivery identity and
  session scope remain isolated.
- A controlled browser, skill, local CLI, or MCP extension whose inventory and
  action authority remain separate.

Treat each example as a pattern to test, not a pre-certified deployment.

## Who owns what

| Stakeholder | Responsibility before and after launch |
| --- | --- |
| Product owner | Choose a bounded user problem, define acceptable human handoffs, set success and stop criteria, and prevent a pilot from becoming an implied guarantee. |
| Platform or runtime owner | Build and run Gantry, Postgres, artifact storage, networking, process roles, upgrades, backups, restore tests, and capacity limits. |
| Security owner | Threat-model exposed routes, configure identity and secrets, review capabilities and permission policy, set retention, and own incident response. |
| Agent or application developer | Design prompts and model aliases, bind Provider Accounts and Conversation Installs, integrate SDK/API surfaces, and test failure paths. |
| Channel or service owner | Approve bot/app installation, provider scopes, trigger rules, sender and approver policy, rate limits, and delivery behavior. |
| Operations or support | Watch readiness, metrics, logs, runs, jobs, worker state, settings convergence, provider failures, and user-visible recovery. |
| Evaluator or risk reviewer | Keep a decision log, verify evidence against the current source snapshot, and decide whether rollout may advance. |

One person may hold several roles in a small team. The responsibilities do not
disappear when the org chart is small.

## A phased rollout

### Phase 0 — frame the decision

Choose one bounded workflow and one accountable owner. Record the information
the agent may read, the actions it may request, the people who can approve
those actions, the expected failure behavior, and the evidence needed to stop
or continue. Read the [product brief](./BRIEF.md), [security model](../SECURITY.md),
and [system atlas](../architecture/system-atlas.md).

### Phase 1 — prove the workstation loop

Build from source, complete `gantry setup`, run `gantry doctor`, and start one
`all`-role runtime against a non-production Postgres database. Configure one
model credential through Gantry, one agent, one Provider Account, and one
Conversation Install. Prove a harmless conversation, an approval denial, a
restart, and the resulting audit trail. Follow the
[learning path](../getting-started.md).

### Phase 2 — run a constrained pilot

Use dedicated test accounts and a small participant group. Start with narrow
capabilities, explicit triggers, named approvers, conservative tool rules, and
a written rollback procedure. Add memory or scheduled jobs only after the live
conversation boundary is understood. Review false approvals, denied actions,
delivery failures, recovery behavior, and support load on a fixed cadence.

### Phase 3 — establish production readiness

Exercise production security posture on one host before changing topology.
Validate route exposure, secrets, backups and restore, retention, readiness,
metrics, logs, sandbox choice, provider ownership, resource limits, upgrades,
and incident response. The checklist below is a starting point, not an audit or
certification.

### Phase 4 — extend deliberately

Add SDK/API integrations, signed ingress, webhooks, skills, MCP servers,
browser use, or local CLIs one capability at a time. Keep inventory separate
from action authority. Test each extension with revoked credentials, denied
permissions, unavailable providers, and duplicate or delayed delivery.

### Phase 5 — rehearse fleet topology

Move canonical state to shared Postgres and artifact bytes to storage visible
to every possible claimant. Rehearse `control`, `live-worker`, and `job-worker`
roles, fencing, drain, recovery, and settings convergence. Do not interpret the
implemented role split as permission for unrestricted multi-instance
production: current rate-limit and LLM concurrency admission authorities are
process-local. Read [scaling and deployment](../architecture/scaling-and-deployment.md)
before making a topology decision.

## Production-readiness questions

- **Ownership:** Is one team accountable for the runtime, database, provider
  accounts, capabilities, and incident response?
- **Exposure:** Are `/v1/*`, `/webhooks/*`, `/healthz`, `/readyz`, and
  `/metrics` routed only to their intended trust zones and process roles?
- **Identity and secrets:** Are API keys scoped, provider credentials brokered,
  secret values kept out of settings and agent workspaces, and rotation tested?
- **Execution:** Are the selected `direct` or `sandbox_runtime` confinement,
  resource limits, capability grants, and permission rules appropriate for the
  workload?
- **Durability:** Have migration, backup, restore, retention, artifact access,
  restart, duplicate ingress, and stale-owner recovery been exercised?
- **Operations:** Do readiness, metrics, logs, run/job evidence, worker state,
  and settings revision convergence produce actionable alerts and runbooks?
- **Providers:** Are receive/send ownership, quotas, scopes, outages, and
  delivery retries understood for every enabled channel and model provider?
- **People:** Can participants identify the agent, understand when approval is
  required, report harm, and reach a human fallback?
- **Scale:** Has the team stayed within the documented process-local authority
  ceilings or completed and reviewed the work needed to supersede them?

## Evaluation scorecard

Capture a baseline and an observation window before the pilot. Segment results
by workflow, provider, agent version, and capability set; averages can hide the
failure mode that matters.

| Question | Example measure | Advance when |
| --- | --- | --- |
| Does the workflow complete? | Share of eligible tasks reaching the human-defined completion state | The product owner accepts the measured result and sampled output quality. |
| Is human effort appropriate? | Approvals, corrections, escalations, and manual recovery per task | The responsible operator accepts the burden and no unsafe shortcut is needed. |
| Is behavior governable? | Denied actions, approval outcomes, capability changes, and actions with complete audit evidence | Every material action has the expected authority and evidence path. |
| Is the service dependable enough? | Successful delivery, duplicate delivery, recovery time, queue age, and provider/runtime error rate | The team-defined service target is met under normal and rehearsed failure cases. |
| Is it operable? | Alert volume, time to diagnose, restore-test outcome, upgrade outcome, and support contacts | The owning team can follow tested runbooks within its staffing model. |
| Is resource use acceptable? | Model usage, cache accounting, database growth, artifact growth, CPU, and memory per completed task | Cost and capacity fit the team's own budget and forecast. |
| Do users choose it? | Eligible use, repeat use, abandonment, and opt-out feedback | The user group finds value without being forced around missing controls. |

Set thresholds locally. Gantry does not publish a universal pass score,
benchmark, customer result, or production guarantee.

## Make the decision

Adopt only the smallest surface that clears your scorecard and readiness
review. If the pilot exposes an authority, operational, or product gap, keep
the deployment constrained or stop. If it clears the bar, advance one phase
and keep the previous rollback point available.

Continue with [Getting started: basic to advanced](../getting-started.md), or
open the [static project explorer](../index.html) to choose another reader path.
