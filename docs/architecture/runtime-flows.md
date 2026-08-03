# Gantry Runtime Flows

This guide follows work across the host-owned boundaries that matter in
production. It complements the interactive
[live-turn sequence](./atlas/live-turn.sequence.html),
[memory dataflow](./atlas/memory-dreaming.dataflow.html), and
[permission lifecycle](./atlas/permission-execution.lifecycle.html). Source
entrypoints are pinned in the [evidence manifest](./atlas/source-evidence.md).

## The invariant common to every flow

Gantry separates four things that are easy to blur:

1. an inbound request establishes authenticated routing context;
2. durable state establishes what work exists and who owns it;
3. selected capabilities plus host policy establish what actions may execute;
4. provider adapters establish how output reaches the caller.

Neither a chat message, SDK call, signed ingress request, job prompt, model
response, nor retrieved memory grants tool authority by itself.

## Provider message to durable admission

1. A configured channel adapter receives a native event for one Provider
   Account. Polling transports first acquire their account-specific inbound
   lease; push transports use their provider connection.
2. The adapter normalizes provider ids, sender identity, conversation/thread
   identity, text, parts, attachments, and provider metadata. Provider SDK
   payloads stop at the adapter boundary.
3. Routing resolves active Conversation Installs. Sender policy is trigger-only:
   every message on a registered route is stored, while the allowlist decides
   whether the message may start a reply.
4. For the normal single-route path, conversation graph state, message, parts,
   participants, and live-admission work are committed together. The wakeup is
   emitted only after commit. Multi-route messages currently commit each route
   independently, so envelope-wide atomicity across routes is deferred.
5. The durable admission loop atomically claims due work. `LISTEN/NOTIFY` is a
   wakeup hint; missed or coalesced notifications are recovered by scanning due
   durable rows.
6. A worker reserves local live capacity and attempts the unique active-scope
   claim for `(app, agent session, conversation, thread)`. If another turn owns
   the scope, the new message becomes a durable continuation command instead of
   starting a duplicate runner.
7. The winner obtains a run lease and fencing version. It may execute only while
   that lease and its capacity hold remain valid.

Durability precedes execution side effects. Overload leaves the admission row
due for another worker/pass; after the configured wait threshold, the recovery
coordinator may send one "Still starting this request" notice for that waiting
episode.

## Context, runner, and model execution

After admission, the live worker prepares one provider-neutral run:

1. It performs the authoritative final message fetch. Gantry deliberately does
   not reuse an earlier admission cursor because a message may arrive between
   admission and execution.
2. It reads bounded channel/thread context. For thread turns, background channel
   context is included but yields first under the formatter byte cap.
3. It resolves the canonical agent session and hydrates memory exactly once for
   the inbound turn. A session-identity fence prevents a carried memory block
   from surviving a detected `/new` or reset; the ordinary read-to-model TOCTOU
   window is a recorded limitation.
4. It composes the selected agent config version, persona, model alias, skills,
   MCP sources/actions, built-in tools, browser/files, sandbox provider, and
   permission projection.
5. The provider-neutral execution adapter selects the configured harness. The
   runner receives per-run materialized config and skill files, not durable
   provider state.
6. Model calls go to the loopback Gantry Model Gateway with a short-lived Gantry
   token. The trusted host selects the approved model route, injects the real
   provider credential, applies admission/accounting, and records usage.
7. Native subagents, when selected, run inside the same parent runner and inherit
   its capability and sandbox projection. They do not become a second durable
   agent, lease owner, or authority domain.

The current LLM concurrency gate is process-local. It bounds each process, not
the aggregate of a fleet; see [Scaling and Deployment](./scaling-and-deployment.md#current-operational-ceilings).

## Permissioned tool execution

A runner request crosses a host-owned gate before the action adapter runs. The
mandatory order is strongest-wins:

1. **Hard deny** — protected paths, credentials, unsafe target shapes, and
   prohibited operations fail closed.
2. **Locked preset** — deployment policy can remove mutability or capability
   classes.
3. **Fixed-image restriction** — immutable worker rules reject host mutation
   that is unavailable in the selected deployment.
4. **Reviewed agent authority** — durable semantic capabilities, trusted roots,
   and narrow action rules are resolved for the target agent.
5. **Deterministic rails** — exact host checks validate the requested target,
   arguments, file boundary, credential route, and provider constraints.
6. **Decision cache, when the lane supplies it** — only a cached classifier
   allow may be reused, scoped to the parent conversation and shared by its
   threads. Human `Allow once` never enters this cache.
7. **Risk classifier, when configured and supplied by the lane** — it returns
   risk only, never authorization. Classifier failure asks rather than allows.
8. **Durable human approval** — the host renders the request to an authorized
   control approver and records the decision. Interactive approval does not
   expire on an arbitrary UI timeout.

`Allow once` is run-transient. Learned trusted roots and `Allow for future`
rules are agent-owned durable authority written through the desired-state
service and mirrored to YAML. Scheduled-job "Store on this job" language is
reserved for job extra-tool review; a job does not gain a parallel job-local
authority system.

The two execution axes remain independent:

- `direct` keeps authorization but has no inner SDK or Gantry OS confinement;
- `sandbox_runtime` applies the same authorization and adds an outer whole-runner
  jail.

The host records allow, deny, cancel, and interaction outcomes. Signed
cancellation remains durable until definitively settled or retention expiry;
transient delivery/handler failures do not consume it.

## Reply commit and delivery

1. Streaming output may be exposed incrementally through its provider adapter,
   but a completed generation is persisted before run finalization.
2. Assistant messages and runtime events are appended to canonical Postgres
   state. A public session resolves by app plus canonical conversation, so its
   history includes internal sessions, agents, and threads in that aggregate.
3. Delivery work is claimed from the durable event/outbox boundary. The route
   carries the exact Provider Account, conversation, and thread identity.
4. The adapter applies provider formatting, chunking, attachment rules, and
   native delivery. It never falls back to a different Provider Account.
5. A receipt, retryable error, partial delivery, or terminal failure is recorded.
   SSE, SDK wait/list, and webhook consumers observe the durable event stream;
   they are not additional command paths.
6. The fenced owner finalizes the run and live turn. A stale worker whose lease
   was recovered cannot overwrite the recovered owner's terminal state.

## Follow-ups, stop, questions, and approvals

While a live runner is active, another worker may receive the next provider
event. It appends a sequenced, idempotent command to `live_turn_commands`:

- `continuation` for a new in-scope message;
- `stop` or `close_stdin` for control input;
- `new_session` or `compact` for session commands;
- `interaction_resolved` after a durable permission/question decision.

The owning worker drains the inbox in sequence under its lease fence.
`LISTEN/NOTIFY` reduces latency, but the rows are authoritative and the owner
tick recovers missed wakeups. `runtime_events` remain observation only.

## Scheduled and autonomous jobs

1. An operator, SDK client, control API call, or authorized scheduler tool
   creates a durable job definition with target, schedule, prompt,
   `execution_context`, `notification_routes`, and access requirements.
2. Readiness resolves the target agent's existing capabilities. A missing
   reviewed capability puts the job in `Setup required`; the job does not invent
   job-local durable authority or run a host script around the gate.
3. The scheduler creates or claims a due run atomically and issues a lease token
   plus monotonically increasing fence. Job workers register and heartbeat in
   Postgres.
4. The job gets its own AgentSession keyed by target agent, source
   conversation/thread, and job id. The host derives any shared memory subject
   from the execution context; callers cannot spoof it.
5. Runner/model/tool execution uses the same host permission and credential
   boundaries as a live turn. Run-scoped approvals bind to the active lease.
6. Tool activity, waits, heartbeat, terminal outcome, and final job report are
   durable. Notification routes are quiet until terminal by default.
7. A stale or expired owner is fenced out. Recovery claims a higher generation
   and records that the previous worker lost its lease.

One-time, recurring, maintenance, memory-dreaming, brain-dreaming, and embedding
backfill work reuse this durable scheduler path. See
[Autonomous Jobs](./autonomous-jobs.md) for job-specific setup and visibility.

## App memory on a turn

1. The host derives the memory boundary: app, agent, and one `user`, `group`,
   `channel`, or `common` subject. Threads/topics do not create a new durable
   memory subject.
2. At explicit continuation boundaries, the host records a recent session
   digest and stages bounded evidence. Pasted content and runtime observations
   become evidence/candidates before active recall.
3. Turn-time recall queries active visible items. Lexical search is always on;
   if embeddings are configured and ready, vector candidates join through
   reciprocal-rank fusion. Provider/budget failure falls back to lexical.
4. The host injects a bounded JSON block as untrusted data-only context. Memory
   text cannot alter system instructions, capability selection, or policy.
5. Manual saves and later extraction add evidence/candidates. Turn-time recall
   never creates embeddings and never makes an LLM proposal authoritative.

`/compact` may capture a digest and evidence, but Gantry does not persist a
compact summary for prompt replay. Full details live in [Memory and Dreaming](../MEMORY.md).

## Memory dreaming and review

Memory dreaming is a default-off system job:

1. The scheduler registers/claims `__system:memory_dream` per workspace folder
   when `memory.dreaming.enabled` and its cron are configured.
2. The maintenance queue deduplicates the folder run and invokes the app memory
   service.
3. The extractor and dream/consolidation model lanes produce schema-bounded but
   untrusted candidates and lifecycle proposals.
4. Host validation rejects sensitive, ungrounded, stale-version, or out-of-scope
   changes.
5. Safe promotions and same-key updates may apply after validation. Retire,
   rewrite, contradiction, and merge proposals enter `memory_review_requests`.
6. Provider-native buttons, control API, SDK, CLI, or the agent-led text flow
   can decide the same row. The host rechecks reviewer, subject, status, and
   target version before mutation.
7. `memory_dream_runs`, `memory_dream_decisions`, and review rows retain the
   proposal, validation, decision, and apply outcome.

## Company brain flows

Company brain is a different app-scoped knowledge system, not a broader memory
subject.

### Import or agent write

1. `gantry brain import`, `POST /v1/brain/import`, or authorized `brain_write`
   supplies a canonical page.
2. The host stores the page, re-extracts entities, replaces evidence edges, and
   keys embeddings by provider/model/content hash.
3. `brain_search` performs lexical and optional hybrid recall. `brain_query`
   synthesizes only from retrieved pages; direct graph questions use stored
   edges.

### Opt-in channel harvest

1. An administrator sets `brain_harvest: true` on a configured conversation;
   the default is off.
2. The canonical inbound persistence seam appends channel/thread or daily pages
   with provider-account/conversation identity embedded in the slug.
3. Harvest currently requires an active installed-agent route. Agent-less source
   subscriptions remain deferred.

### Brain dreaming

The trusted `__system:brain_dream` job reads pages since a durable cursor and
asks the memory model lane for schema-validated operations. Additive operations
may apply after host validation. Destructive proposals are journaled in
`brain_dream_decisions` and are not applied. This is separate from memory
candidate promotion and its human review queue.

## Recovery paths

| Failure | Durable response |
| --- | --- |
| Admission worker stops before claim | Due admission remains claimable; notification loss does not lose the row. |
| Live owner stops or loses lease | Recovery coordinator claims a higher fence and resumes, or marks an unleased stale claim timed out. |
| Continuation/stop reaches a non-owner | It is appended to the owner's command inbox and replayed in sequence. |
| Permission/question crosses restart | `pending_interactions` survives; resolution appends a fenced command to the current owner. |
| Job worker stops | Lease expiry and stale heartbeat permit a higher-fenced retry; old terminal writes fail. |
| Settings notification is lost | Worker polling finds the newer revision; incompatible readers hold last applied state and readiness remains red. |
| Settings projection fails | Revision authority forward-corrects by retrying the latest full state; readiness stays red until success. Workstation file imports can roll back to explicit last-known-good settings. |
| Provider-history coverage is ambiguous | Gantry marks it incomplete and hydrates again; a false incomplete costs a fetch, while a false complete could permanently hide messages. |
| Embedding provider is unavailable | Turn-time memory falls back to lexical; backfill pauses for later resume. |
| Provider delivery fails | Durable delivery/outbox state records retryable, partial, or terminal outcome without changing the run's execution authority. |
| Browser profile owner disappears | Durable advisory lease/generation prevents a stale snapshot from overwriting a newer owner; some connect/teardown loss handling remains deferred. |

Terminal live-admission work is retained for 30 days, then a maintenance sweep
deletes only old terminal rows. Longer-term forensics must use logs and
telemetry.

