# Gantry Website Launch Pack

This pack is for the first public Gantry website pass. It is grounded in the
current repo, the investor brief, the talk visuals, the current Control API and
SDK surfaces, the Learning Loop product direction, and the Legora layered hero
reference.

Use it to build a one-page launch site, plan the first control-panel screenshots,
and brief the hero motion. Do not use it as a claims document for unfinished
features.

## Source Anchors

- Product definition: `README.md`
- Investor/product narrative: `docs/Gantry_Investor_Brief.html`
- Visual palette and diagram discipline: `docs/talk/visuals.md`
- Runtime map: `docs/architecture/overview.md`
- Control API and SDK surfaces: `docs/sdk/api-reference.md`
- Agent-facing Gantry MCP tools: `apps/core/src/runner/gantry-mcp-tool-surface.ts`
- Admin Gantry MCP tools: `apps/core/src/shared/admin-mcp-tools.ts`
- Product direction: the Gantry Learning Loop plan supplied in this thread
- Motion reference: `https://legora.com/`, specifically the layered `aOS`
  section pattern

## One-Pager Markdown

# Gantry

## The control layer for agents that touch real work.

Gantry gives teams a safe place to run AI agents across chat, apps, scheduled
work, and internal systems. It keeps approvals, memory, evidence, and model
choice under the team's control, so every useful correction can become part of
how the agent gets better.

It is not a chatbot. It is not a prompt playground. It is not a no-code workflow
builder.

**Primary CTA:** Book a technical walkthrough
**Secondary CTA:** See how Gantry works

### Agents fail in production when they hold too much power.

Enterprises want agents close to real work: team chat, product screens,
scheduled jobs, internal tools, customer records, and model providers. That is
exactly where the risk shows up.

If an agent can silently add access, read the wrong memory, hold raw keys, or act
without a durable trail, it will stall at pilot. Gantry gives builders a control
layer that lets the agent work without giving the model standing authority.

### One layer for every way work arrives.

Gantry brokers work between:

- people in chat
- product and support screens
- scheduled work
- trusted application events
- approved business tools
- durable memory, job history, secrets, and audit records

The same layer handles live chat, background jobs, and product actions. The path
is shared: receive the work, bring in the right memory, check access, record
evidence, and deliver the result.

### Trust is a product contract, not a prompt.

An agent in Gantry has no standing power. It asks for access when the work needs
it. A human approver reviews the request. Gantry records the decision and makes
the access available only through the governed path.

That lifecycle is visible:

`ask -> review -> decide -> record -> use through the governed path`

The agent cannot approve itself. A connected source is not the same thing as
permission to act. Provider keys stay behind Gantry. Broad tool access is never
the default.

### Memory is scoped before it is useful.

Gantry memory belongs to the right person, team, conversation, and agent.
Conversation history can become useful memory, but shared context does not
silently become private user memory. The pitch is not "remembers everything."
The pitch is memory that knows where it is allowed to belong.

### Production work becomes learning evidence.

The product direction is simple: capture what happened, measure what improved,
turn corrections into reusable judgment, and deploy better agents without
locking the team to one model. Launch copy should claim the current foundation,
not the unfinished loop. Gantry records the evidence that makes that loop
possible: messages, actions, approvals, corrections, memory updates, job
outcomes, delivery events, and model choices.

That matters because the model can be swapped without losing the team's learning
trail. Today, the website can say Gantry gives teams the evidence needed to
measure progress and improve safely. It should not say Gantry already runs an
evaluation system, trains models, or serves a customer-owned model.

### The control surface is operational.

The website should show Gantry as software a team can operate:

- health and readiness
- agent setup, connected workspaces, and approvers
- access requests, approvals, and audit history
- runs, corrections, memory updates, and delivery evidence
- scheduled jobs and setup blockers
- model choices and compatibility warnings
- trusted app events and outbound notifications

The control panel should look like mission control for governed agents, not a
prompt playground.

### Built for builders who need the agent to touch real systems.

Gantry lets a team embed an agent into its own product and keep its own product
in charge. The app supplies identity. Gantry handles execution, memory,
approvals, model access, delivery, and evidence.

The visible promise:

**Let the agent work where the work already happens, without giving the model raw
power over the system, and without losing the evidence needed to improve it.**

## Control Panel Screenshot Shot-List

Goal: show that Gantry is operable software. Each screenshot should feel like a
real runtime screen backed by current API surfaces. Use sanitized demo data and
provider-neutral ids. Keep raw provider ids, queue keys, provider run ids, and
secrets out of primary UI.

| # | Shot | Capture This State | Backing Surface | Avoid |
|---|------|--------------------|-----------------|-------|
| 1 | Runtime health | Process role, `GET /v1/health`, `GET /v1/doctor`, readiness checks, metrics link, OpenAPI/docs link | `/healthz`, `/readyz`, `/metrics`, `/v1/health`, `/v1/doctor`, `/docs`, `/openapi.json` | Do not present unauthenticated ops endpoints as public internet routes. |
| 2 | Settings desired state | Read-only effective settings, fleet desired-state revision, note, updated time, validation errors, disabled direct patch state | `GET /v1/settings`, `GET/PUT /v1/settings/desired-state`, settings revisions | Do not show `PATCH /v1/settings` as a mutation path. It is read-only. |
| 3 | Agent admin overview | Selected agent, status, `agentHarness`, bound conversations, policies, approvers, current access summary | `GET /v1/agents/:id/admin`, `GET/PATCH /v1/agents/:id` | Do not expose `executionProviderId` as writable. |
| 4 | Access and capabilities | Inventory, capability catalog, attached sources, durable selections, effective `toolAccess`, requestable admin tools | `GET /v1/inventory`, `GET /v1/capabilities`, `GET/PUT /v1/agents/:id/access` | Do not imply sources grant execution authority by themselves. |
| 5 | Permission and correction review | Request detail, approver, decision buttons, correction or rejection note, audit trail, selected admin tools, `request_access` metadata in details | Gantry MCP tools, admin tools, permission decisions | Do not present corrections as training pairs or automatic learning. |
| 6 | Provider conversations | Provider connections, status, discovered conversations, threads, approvers, bound agent | Providers, provider-connections, conversations, approvers APIs | Do not imply Slack, Teams, Telegram, and App/Web user ids are interchangeable. |
| 7 | SDK session console | Ensure session, send message, accepted message id, durable event id, stream/wait view, messages, runs, delivery evidence | Sessions API and event stream | Do not imply `accepted` means model completion or channel delivery. |
| 8 | Jobs and runs | Job create/dry-run drawer, runtime context preview, model alias, setup blockers, notification routes, run events, evidence timeline | Jobs API, Runs API | Do not show jobs as owning separate tool authority. They inherit agent access. |
| 9 | Model control | Model aliases, defaults, preview response, credential profile, `agentHarness`, compatibility error state | Models/defaults/preview APIs | Do not accept or display raw provider model ids as user input. |
| 10 | Ingress and webhooks | Signed ingress target policy, rotate secret action, conversation message target, outbound webhook subscribers | `/v1/ingresses`, `/v1/webhooks` | Do not describe `/v1/webhooks` as inbound authority. Ingress is separate. |

Learning-loop extension shots are roadmap/internal until implemented. Do not use
public screenshots for self-hosted Langfuse trace capture, private eval
datasets, elicitation scenario libraries, trainer dispatch, SFT/DPO/GRPO runs,
or owned model registry/serving as if they are shipped Gantry control-panel
screens.

## Hero Animation Brief

### Concept

Use Legora's layered hero pattern only as structural inspiration. Gantry's
version should feel like a launch gantry assembling around an agent core: work
surfaces, access, agent work, approved actions, memory, evidence, policy, and
audit lock into place before work leaves the system.

The message is not "AI does work." The message is "Gantry keeps agent work under
control, and preserves the evidence needed to improve it."

### Layer Stack

Use seven deterministic HTML/SVG labels:

1. **Work Surfaces**: chat, product screens, scheduled work
2. **Trusted Entry Points**: app events, requests, and notifications
3. **Run Coordination**: live work, background jobs, recovery
4. **Agent Work**: model choice, task execution, delivery
5. **Approved Actions**: business systems, files, connectors
6. **Memory & Evidence**: scoped memory, runs, corrections, artifacts
7. **Policy & Audit**: approvals, secrets, boundaries, records

Keep **Agent Work** as the visual center of gravity.

Optional learning-loop overlay: after the stack locks, trace a thin restrained
orbit around the core labeled **Capture**, **Eval**, **Improve**, **Deploy**.
For launch, keep **Capture** visually strongest and treat the rest as product
direction, not proof of shipped measurement, training, or owned-model surfaces.

### Motion

- Initial reveal: 1.8 to 2.4 seconds.
- Start with a quiet center core.
- Bring layers in from foundation upward with 120 to 180ms stagger.
- Pulse one restrained mint connector as each layer locks.
- On scroll or hover, brighten one layer and dim the rest to 35 to 45 percent
  opacity.
- Show a one-line caption for the focused layer.
- On mobile, switch to a vertical stacked reveal with readable labels.
- Respect reduced-motion by showing the final stacked state with no stagger.
- Do not animate model training, weights, or an owned model as a current shipped
  product path.

### Art Direction

Use the KnackLabs/Gantry dark system:

- background black: `#0b0b0b`
- deep evergreen: `#0c3529`
- mid green: `#18884f` and `#1c6b49`
- restrained mint accent: `#6af1b0`
- off-white text and linework: `#f8f8f8`
- muted slate captions: `#758696`

No purple gradients. No floating blobs. No magical sparkles. No text baked into
raster art. Render labels in the DOM.

### Implementation Notes

Build the first version in HTML/SVG or Canvas with real text labels and CSS
transforms. Use video generation only after the timing and labels are approved,
and only for a social teaser or background plate. The website hero should remain
inspectable, responsive, accessible, and easy to revise.

## Copy And Claim Guardrails

Use:

- "safe place for agents to work"
- "control layer"
- "access approvals"
- "human approvers"
- "right memory in the right place"
- "model choice"
- "audit trail"
- "trusted app events"
- "outbound notifications"
- "owned learning loop foundation"
- "learning evidence"
- "corrections as signal"
- "evidence needed to measure improvement"
- "self-hosted evaluation layer" only as product direction or roadmap context

Avoid:

- "AI-powered platform"
- "copilot"
- "unlock productivity"
- "seamless AI automation"
- "no-code agent builder"
- "one platform for all AI"
- "memory that remembers everything"
- "multi-agent mission control" as a current product claim
- `RunCommand`
- `browser.use`
- `MCP`
- `toolAccess`
- `agentHarness`
- `OpenAPI`
- WhatsApp as a shipped adapter
- five-line terminal receipts as already host-enforced
- `PATCH /v1/settings` as a mutation route
- provider-native tool names or raw provider model ids as public authority
- "self-improving agents"
- "automatic fine-tuning"
- "Langfuse-backed evals are live"
- "owned ELM serving today"
- "RL from your company data"
- "training inside Gantry"
- "Gantry trains models in-process"

## Surface Impact Matrix

| Surface | Classification | Reason |
|---------|----------------|--------|
| Runtime behavior | Unchanged by design | Docs-only launch positioning; no runtime change. |
| `settings.yaml` | Read-only/observable | Desired-state ownership is described for screenshots; no settings change. |
| Postgres/runtime projection | Read-only/observable | Existing events, runs, messages, and memory evidence are referenced only as current surfaces. |
| Control API | Read-only/observable | Current routes are used as screenshot anchors. |
| SDK/contracts | Read-only/observable | Current SDK semantics are referenced, not changed. |
| CLI | Unchanged by design | No CLI behavior or docs changed. |
| Gantry MCP tools/admin skill | Read-only/observable | Tool names anchor permission screenshots. |
| Channel/provider adapters | Unchanged by design | Provider claims are constrained to current surfaces. |
| Docs/prompts | Changed | Adds this launch-pack markdown file and positions Gantry around governed runtime plus learning-evidence foundation. |
| Audit/events | Read-only/observable | Audit and runtime events are described as evidence surfaces. |
| Tests/verification | Changed | Verification is focused docs/source review and forbidden-claim search, not runtime tests. |
