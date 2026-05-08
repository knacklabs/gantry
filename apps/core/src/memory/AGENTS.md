## Memory Rules

- Dreaming must not convert raw `memory_evidence.text` into active memory.
- Fresh-run recall context should place recent persisted session digests ahead of active durable memory items; ordinary memory recall remains based on active `memory_items`.
- Fresh-run hydration should read persisted `agent_session_digests` (not legacy session summaries) and should query app-memory recall paths so hashed subject ids remain resolvable.
- Session digest hydration must require exact `sessionScope` metadata for the
  current app, agent, conversation, user, and thread; unscoped or ambiguous
  digest rows fail closed instead of being inferred from `agentSessionId`.
- Subject resolution for automatic boundary evidence, manual memory/procedure saves, hydration recall scopes, and memory dreaming triggers must use the same scope resolver so channel/group and DM/private boundaries stay consistent.
- Normal runtime memory search/status hydration must pass the resolved subject type explicitly (`user` for DM/private, `channel` for channel/group) and must not make channel contexts visible to legacy agent-folder `group` rows.
- `/dream`, scheduled dreaming, `/memory-status`, and `/save-procedure` must use trusted conversation context: DM/private uses the trusted user id and drops thread scope; channel/group uses the trusted conversation id and may retain thread/topic scope.
- Memory IPC must enforce host-derived allowed actions from the signed runtime context/token. Reviewed actions such as `memory_patch`, `procedure_patch`, `memory_dream`, and `memory_consolidate` must stay denied unless the selected MyClaw MCP capability explicitly enables the matching action.
- IPC patch actions must resolve the subject with the same trusted resolver used by search/save; never trust `group_folder`, `user_id`, channel, or thread hints from the patch payload.
- If digest or app-memory hydration dependencies are missing, fail closed to an empty memory context; never fall back to legacy session summaries or legacy memory-item reads.
- Production `CanonicalSessionOpsService` hydration must pass `loadAppMemoryItems` with the current turn query when available; query-aware hydration searches app-memory first, then tops up from `list` using session-derived app/agent/user/conversation/thread scope. Direct/private conversations stay user-scoped, channel/group conversations stay channel-scoped, and `thread_id` only narrows channel/group scope.
- Canonical session rows persist provider-session scope keys from the exact trusted conversation boundary (`<group-folder>::conversation:<jid>` plus DM user and child thread/topic when applicable) and canonical conversation/thread ids; hydration must map canonical ids back to app-memory identities (`groupId` and raw thread) so memory IPC writes and resume hydration use the same subject contract.
- Automatic boundary evidence must use that same canonical-session to app-memory
  thread mapping before subject resolution; do not save evidence under
  canonical `thread:<conversation>:<raw-thread>` ids when hydration and
  dreaming use the raw provider thread id.
- Boundary extraction prior-memory retrieval must use the app-memory hydration
  read path with exact app, agent, subject, and raw thread scope; never load
  prompt context through legacy `MemoryRepository.listMemoryItems`.
- The production legacy `MemoryRepository` must not expose list/search reads;
  keep any future diagnostic legacy read path explicitly non-runtime and guarded
  by architecture tests.
- Encoded session-scope components from `makeSessionScopeKey` must be decoded
  before becoming app-memory identities, so Teams-like thread ids such as
  `19:abc@thread.v2` stay raw in hydration and boundary extraction.
- DM/private and channel/group boundaries are top-level memory scopes; `thread_id` is only a child narrowing scope for channel/group memory, never a standalone top-level scope.
- Light dreaming may stage a candidate only from structured evidence metadata
  that passes canonical kind, confidence, scope, and safety guardrails.
- Dreaming `dryRun` may record unapplied decisions, but must not insert
  candidates, update candidate status, or promote memory items.
- Deep dreaming must revalidate staged candidates before promotion and record
  skipped or blocked operations in `memory_dream_decisions`.
- LLM dreaming and consolidation outputs are advisory JSON proposals only.
  Durable mutation still requires host validation against subject scope,
  evidence ids, current target versions, allowed memory kinds, confidence, and
  sensitive-material checks.
- Retire, rewrite, contradiction, and merge proposals belong in
  `memory_review_requests` with `pending_review` status; do not route these
  through `request_permission`, because review approves a specific data
  mutation rather than a reusable capability grant.
- Staged retire candidates must create pending memory reviews. They must not
  call `delete` directly from dreaming, even after candidate validation.
- `memory_review_decision` must use the trusted runtime context user id as the
  reviewer. Do not accept reviewer identity from tool payload JSON.
- Reviewed retire/rewrite/merge application must use current target versions.
  Merges must retire duplicate items atomically or fail without partial
  mutation.
- Thread-scoped durable memory identity must include `thread_id` in active-key
  uniqueness (with `COALESCE(thread_id, '')`) so same keys can coexist across
  threads while no-thread memory remains intentionally shared.
- Dreaming triggered from trusted thread context must filter evidence,
  candidates, and active-item operations by exact `thread_id`; background or
  scheduled dreaming should run with explicit no-thread scope.
- All dreaming entrypoints (runtime queue, control API, and memory IPC actions)
  must converge on the same durable running-subject guard keyed by boundary,
  phase conflict set, and `lease_expires_at`; `phase='all'` is a wildcard that
  conflicts with `light`, `rem`, and `deep`, and expired running rows must be
  marked failed before a replacement run is acquired.
- Dream embedding writes must be deadline-bounded and retryable; slow or hung
  embedding providers must not block the global maintenance queue indefinitely.
- Dream embedding readiness validation uses the same deadline as embedding
  writes and must finalize the dream run as failed/retryable instead of hanging
  the serial maintenance queue.
- Keep thread-aware indexes aligned with dreaming query filters:
  `memory_evidence(app_id, agent_id, subject_type, subject_id, thread_id, created_at DESC)`
  and
  `memory_candidates(app_id, agent_id, subject_type, subject_id, thread_id, status, confidence DESC, updated_at DESC)`.
- Keep active-memory recall and hydration indexes thread-aware:
  `memory_items(app_id, agent_id, subject_type, subject_id, status, thread_id, updated_at DESC)`.
- Whole-conversation boundary capture is intentional when `thread_id` is absent;
  keep a dedicated recent-message ordering index on
  `messages(conversation_id, created_at DESC, id DESC)` so no-thread capture
  stays efficient without narrowing to unthreaded rows.
- Automatic durable promotion/update must stay dreaming-only; boundary capture
  flows must not bypass dreaming review into active memory promotion logic.
- Embedding/index update work should run only during dreaming
  promotion/update flows, never as a requirement for turn-time recall.
- IPC `memory_save.kind` must fail visibly when present and not one of
  `preference`, `decision`, `fact`, `correction`, or `constraint`; omitted kind
  may continue to use the service default.
- Direct HTTP `POST /v1/memory` uses the same direct-save kind allowlist.
- Automatic boundary capture (`precompact`/`session-end`) must persist
  `agent_session_digests` and grounded `memory_evidence` metadata first; it
  must not write active `memory_items` directly.
- Boundary extraction prompts must enforce per-part, per-turn, and total
  transcript budgets before LLM calls, and large text/code/tool payloads should
  be structurally summarized instead of forwarded verbatim.
- Retrieved memory included in boundary extraction prompts must share that same
  total budget with transcript turns; keep ids, but sanitize and truncate
  key/value text before the extractor serializes `retrieved_items`.
- Session digests must never persist raw `tool_result`/structured payload
  bodies; digest capture stores only safe structural summaries and redacts
  sensitive text before persistence and hydration reinjection.
- Keep `app-memory-service.ts` and `app-memory-dreaming.ts` under the
  architecture file-size budget by moving cohesive recall/candidate guardrail
  helpers into narrowly named sibling modules.
