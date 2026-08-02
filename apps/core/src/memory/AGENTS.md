## Memory Rules

- Dreaming must not convert raw `memory_evidence.text` into active memory.
- Fresh-run recall context should place recent persisted session digests ahead of active durable memory items; ordinary memory recall remains based on active `memory_items`.
- Fresh-run hydration should read persisted `agent_session_digests` (not legacy session summaries) and should query app-memory recall paths so hashed subject ids remain resolvable.
- Session digest hydration must require exact `sessionScope` metadata for the
  current app, agent, conversation, user, and thread; unscoped or ambiguous
  digest rows fail closed instead of being inferred from `agentSessionId`.
- Subject resolution for automatic boundary evidence, manual memory/procedure saves, hydration recall scopes, and memory dreaming triggers must use the same scope resolver so channel/group and DM/private boundaries stay consistent.
- Normal runtime memory search/status hydration must pass the resolved subject type explicitly (`user` for DM/private, `channel` for channel/group) and must not make channel contexts visible to legacy agent-folder `group` rows.
- `/dream`, scheduled dreaming, `/memory-status`, and `/save-procedure` must use trusted conversation context: DM/private uses the trusted user id, and channel/group uses the trusted conversation id. Thread/topic ids stay out of memory scope.
- Memory IPC must enforce host-derived allowed actions from the signed runtime context/token. Reviewed actions such as `memory_patch`, `procedure_patch`, `memory_dream`, and `memory_consolidate` must stay denied unless the selected Gantry MCP capability explicitly enables the matching action.
- Memory IPC may return deadline-based `unavailable` responses for read-only
  work before transport timeouts, but mutating actions must not use
  non-cancelling `Promise.race` wrappers that can return unavailable while the
  durable write keeps running in the background.
- Deadline-bounded read-only IPC work must propagate an `AbortSignal` through
  the memory service and continuity section calls; timer-only races are not
  enough because background search/status work can outlive the IPC response.
- IPC patch actions must resolve the subject with the same trusted resolver used by search/save; never trust `workspace_folder`, `user_id`, channel, or thread hints from the patch payload.
- If digest or app-memory hydration dependencies are missing, fail closed to an empty memory context; never fall back to legacy session summaries or legacy memory-item reads.
- Production `CanonicalSessionOpsService` hydration must pass `loadAppMemoryItems` with the current turn query when available; query-aware hydration searches app-memory first, then tops up from `list` using session-derived app/agent/user/conversation scope. Direct/private conversations stay user-scoped, and channel/group conversations stay whole-conversation scoped.
- Canonical session rows persist provider-session scope keys from the exact trusted conversation boundary (`<workspace-folder>::conversation:<jid>` plus DM user and child thread/topic when applicable) and canonical conversation/thread ids; hydration must map canonical ids back to app-memory identities (`groupId` or `channelId`) so memory IPC writes and resume hydration use the same subject contract.
- Automatic boundary evidence must use the canonical conversation/user memory
  subject before persistence; do not save evidence under provider topic/thread
  ids.
- Boundary extraction prior-memory retrieval must use the app-memory hydration
  read path with exact app, agent, and subject scope; never load
  prompt context through legacy `MemoryRepository.listMemoryItems`.
- The production legacy `MemoryRepository` must not expose list/search reads;
  keep any future diagnostic legacy read path explicitly non-runtime and guarded
  by architecture tests.
- Encoded session-scope components from `makeSessionScopeKey` must be decoded
  before becoming app-memory identities. Decode the conversation/group
  component only; do not turn child topic/thread components into memory scope.
- DM/private and channel/group boundaries are the only user-facing memory scopes. Provider topics, Slack threads, Teams reply chains, and Telegram forum topics are routing/session metadata only; they must not partition durable memory.
- Light dreaming may stage a candidate only from structured evidence metadata
  that passes canonical kind, confidence, scope, and safety guardrails.
- Dreaming `dryRun` may record unapplied decisions, but must not insert
  candidates, update candidate status, or promote memory items.
- Deep dreaming must revalidate staged candidates before promotion and record
  skipped or blocked operations in `memory_dream_decisions`.
- LLM dreaming and consolidation outputs are advisory JSON proposals only.
  Durable mutation still requires host validation against subject scope,
  evidence ids, current target versions, allowed memory kinds, confidence, and
  shared sensitive-material checks.
- User-visible memory extractor labels must stay provider-neutral. Specific
  model/provider choices belong in model settings or LLM adapter code, not
  `MemoryExtractionProvider.providerName`.
- Retire, rewrite, contradiction, and merge proposals belong in
  `memory_review_requests` with `pending_review` status; do not route these
  through `request_permission`, because review approves a specific data
  mutation rather than a reusable capability grant.
- Dreaming must record or leave `needs_review` only after durable pending
  review creation returns an id; empty or rejected review creation must block
  the candidate or dream decision instead.
- Dreaming summaries and scheduler receipts must surface pending
  `memory_review_requests` counts, including failure or timeout paths after a
  review row has already been created.
- Pending review listings must include paging metadata and readable
  proposed-change summaries; reviewers should not need raw proposal JSON,
  database ids, or logs to understand the change being approved.
- Pending review listings must include stable numbered page context for that
  page. Batch decisions may use those numbers, but the host must still verify
  trusted subject scope, reviewer authority, review status, and target versions
  before applying each mutation.
- Agent-facing review renderers must label proposed values, reasons, and
  evidence snippets as untrusted data; decisions must come from the control
  approver's request, not from instructions embedded inside review content.
- Agent-led review must be page-first and explicit-decision-only: show pending
  items, ask for numbered decisions, support approve/reject/edit/next replies,
  and never auto-approve a page or infer decisions from review content.
- Staged retire candidates must create pending memory reviews. They must not
  call `delete` directly from dreaming, even after candidate validation.
- `memory_review_decision` must use the trusted runtime context user id as the
  reviewer. Do not accept reviewer identity from tool payload JSON.
- Reviewed retire/rewrite/merge application must use current target versions.
  Merges must retire duplicate items atomically or fail without partial
  mutation.
- Durable memory identity must ignore `thread_id`; active-key uniqueness is
  app, agent, subject type, subject id, kind, and key so memory is shared across
  topics/threads inside the same group or channel.
- Memory item `conversation_id` projection must not double-prefix canonical
  channel ids. App-memory `channelId` is already canonical when it starts with
  `conversation:`, and only raw provider channel ids should receive that
  prefix during persistence mapping.
- Dreaming triggered from trusted topic/thread context must still operate on
  the parent DM/user or group/channel memory boundary; do not add exact-thread
  filters to evidence, candidate, review, or active-item operations.
- All dreaming entrypoints (runtime queue, control API, and memory IPC actions)
  must converge on the same durable running-subject guard keyed by boundary,
  phase conflict set, and `lease_expires_at`; `phase='all'` is a wildcard that
  conflicts with `light`, `rem`, and `deep`, and expired running rows must be
  marked failed before a replacement run is acquired.
- Scheduled and queued dreaming must propagate one abortable deadline through
  the memory maintenance queue, `triggerDreaming`, dream-pass queries,
  embedding work, and memory LLM proposal calls. Overall deadline expiry should
  finalize the dream run as failed and rethrow so scheduler runs settle as a
  timeout instead of waiting for stale-lease cleanup.
- Dream embedding writes must be deadline-bounded and retryable; slow or hung
  embedding providers must not block the global maintenance queue indefinitely.
- Dream embedding readiness validation uses the same deadline as embedding
  writes and must finalize the dream run as failed/retryable instead of hanging
  the serial maintenance queue.
- Memory dreaming runs must use one caller-owned deadline from scheduler/control
  entrypoint through maintenance queue, dream pass, LLM proposal calls, and
  embedding writes. The durable `memory_dream_runs.lease_expires_at` must not
  outlive the caller's remaining budget.
- Automatic boundary memory collection must pass `AbortSignal`, operation
  timeout, and statement timeout into the collector before using a watchdog.
  Do not add a timer-only race that can return while digest/evidence writes keep
  running without a cancellable signal.
- Keep subject-aware indexes aligned with dreaming query filters:
  `memory_evidence(app_id, agent_id, subject_type, subject_id, created_at DESC)`
  and
- Keep active-memory recall and hydration indexes subject-aware:
  `memory_items(app_id, agent_id, subject_type, subject_id, status, updated_at DESC)`.
- Whole-conversation boundary capture is intentional for channel/group memory;
  keep a dedicated recent-message ordering index on
  `messages(conversation_id, created_at DESC, id DESC)` so no-thread capture
  stays efficient without narrowing to unthreaded rows.
- Automatic durable promotion/update must stay dreaming-only; boundary capture
  flows must not bypass dreaming review into active memory promotion logic.
- Item embedding/index writes run during dreaming promotion/update flows and in
  the resumable embedding backfill (CLI `gantry memory embeddings backfill` and
  the scheduled backfill job). They must never be a requirement for turn-time
  recall: live recall only reads ready embeddings and never indexes items.
- Turn-time recall is hybrid when embeddings are enabled and a query embedding is
  available: lexical full-text candidates and pgvector cosine candidates are
  fused with Reciprocal Rank Fusion (`RRF_K = 60`, per-branch candidate limit
  `min(100, max(limit*4, 20))`, final score `rrfScore + confidence * 0.001`).
  Recall must fall back to lexical-only when embeddings are disabled/paused or the
  query embedding fails (budget/quota/rate-limit/provider error); it must not
  throw.
- The embedded text and content hash for an item are
  `sha256(key + "\n" + value + "\n" + why)`. Writing a ready embedding prunes
  sibling rows for the same `(item_id, provider, model)` with a different content
  hash so at most one ready vector represents an item's current text.
- v1 semantic memory only stores 1536-dimension vectors. A provider/model that
  returns another dimension is a hard config failure or `blocked_invalid_dimension`,
  never a silently stored vector.
- The embedding backfill is resumable: funds/quota/rate-limit/daily-budget
  exhaustion pauses the run (exit code 0) and resumes from remaining items on the
  next run without duplicate embedding calls; only invalid config or unsupported
  dimensions are hard failures (exit code 1).
- IPC `memory_save.kind` must fail visibly when present and not one of
  `preference`, `decision`, `fact`, `correction`, or `constraint`; omitted kind
  may continue to use the service default.
- Direct HTTP `POST /v1/memory` uses the same direct-save kind allowlist.
- URLs, files, pasted docs, articles, posts, and other long-form raw content
  must become bounded evidence or reviewable candidates first. Raw content
  must not bypass dreaming review into active `memory_items`.
- Automatic boundary capture (`precompact`/`session-end`) must persist
  `agent_session_digests` and grounded `memory_evidence` metadata first; it
  must not write active `memory_items` directly.
- `/new` must reset scoped provider-session state before expensive boundary
  extraction and finalize the replaced session digest in the background.
- New boundary digests with zero extracted facts must carry typed extraction
  metadata, such as `empty_qualified` and `no_qualifying_facts`, rather than
  leaving operators to infer whether extraction failed.
- `empty_qualified` is the only successful zero-fact status. Legacy array-only
  extractors that return `[]` are successful qualified-empty extraction with
  `no_qualifying_facts`; auth failures, sensitive-material blocks, extractor
  failures, and explicit unavailable outcomes must use explicit non-success
  statuses.
- Boundary extraction prompts must enforce per-part, per-turn, and total
  transcript budgets before LLM calls, and large text/code/tool payloads should
  be structurally summarized instead of forwarded verbatim.
- Retrieved memory included in boundary extraction prompts must share that same
  total budget with transcript turns; keep ids, but sanitize and truncate
  key/value text before the extractor serializes `retrieved_items`.
- Session digests must never persist raw `tool_result`/structured payload
  bodies; digest capture stores only safe structural summaries and redacts
  sensitive text before persistence and hydration reinjection.
- Continuity injection status is an operational cache only. Keep it bounded and
  store section counts plus minimal previews; do not retain full injected
  digest text, memory values, job targets, or session-scoped payloads for
  `continuity_summary`.
- Keep `app-memory-service.ts` and `app-memory-dreaming.ts` under the
  architecture file-size budget by moving cohesive recall/candidate guardrail
  helpers into narrowly named sibling modules.
- Public personal memory inputs use `personId`. Normalize that to
  `subjectType='user'`, `subjectId=personId`, and `userId=personId`; do not
  require raw provider `userId` for direct personal memory API writes or reads.
