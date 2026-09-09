BLOCKING

1. The `SessionCommandDeps.remembered` contract omits the identity and route data the command requires.
   Evidence: the plan fixes the member as only `{ service, usedBy, timezone }` while also requiring person, app, folder, and group/DM state (`plans/exploration/askfloor-1-t5b-taskplan.md:13`); `handleSessionCommand` receives no route context outside `deps` (`apps/core/src/session/session-commands.ts:245-252`).
   Plan fix: include `{ appId, agentFolder, conversationKind, resolvePersonId, service, usedBy, timezone }` in the single member, or make the caller resolve and supply that complete context before invocation.

2. `MessageLoopDeps` is not the dependency path into session-command processing.
   Evidence: it owns message-loop queue/channel functions only (`apps/core/src/runtime/message-loop.ts:47-98`); the real `GroupProcessingDeps` closure is constructed separately in `runtime-app.ts:574-661`. The object at `runtime-services.ts:1121-1138` never reaches that closure.
   Plan fix: replace the MessageLoopDeps ruling with a named RuntimeApp-to-GroupProcessing injection/setter, scope `group-processing-types.ts` and the capped `runtime-app.ts`, and specify the extraction needed to keep RuntimeApp under 739 lines.

3. The Forget factory cannot resolve its required app/agent route as specified.
   Evidence: its declared inputs omit `appId` (`plans/exploration/askfloor-1-t5b-taskplan.md:15`); `ConversationRoute` has no app ID (`apps/core/src/domain/types.ts:109-123`); `memory_forget` carries neither agent nor route identity (`apps/core/src/domain/message-actions.ts:112-118`). Route selection without an agent fails on multiple route identities (`apps/core/src/shared/thread-queue-key.ts:267-281`).
   Plan fix: inject the runtime app ID explicitly and carry a host-validated agent/route key in the affordance and provider callback, then resolve by conversation, thread, provider account, and agent.

4. The active-list pre-read makes `already_revoked` unreachable.
   Evidence: `listHumanDecisions` excludes revoked rows by default (`apps/core/src/adapters/storage/postgres/repositories/permission-decision-memory-repository.postgres.ts:215-234`), while `already_revoked` is determined only after the active update fails (`:277-312`). The plan requires the active list before calling revoke (`plans/exploration/askfloor-1-t5b-taskplan.md:15`).
   Plan fix: expose a current-rails, person-scoped exact-ID read including revoked rows, or allow `service.list({ includeRevoked: true })` for button handling. Active prefix/list commands must retain the current active-only read.

5. Existing rows cannot render the promised exact-action scope noun.
   Evidence: the stored row has no display/action snapshot (`apps/core/src/domain/ports/permission-decision-memory.ts:34-58`); non-path exact scopes store only an opaque effect hash (`apps/core/src/application/permissions/human-decision-scope.ts:79-95`). The alleged movable helper is absent: the cited channel module only formats buttons and receipts (`apps/core/src/channels/permission-card-affordances.ts:52-75`).
   Plan fix: persist a sanitized scope-display snapshot at remember time, including its schema/migration/port/service changes, or explicitly narrow the product copy to information recoverable from existing rows.

6. The provider-neutral Forget result has no real type and is not a complete replacement message.
   Evidence: the plan invents `{ reply, listing }` (`plans/exploration/askfloor-1-t5b-taskplan.md:15`), but `OnMemoryForgetMessageAction` returns `MessageActionOutcome`, whose fields are `receipt`, `replacementText`, and no listing view (`apps/core/src/domain/message-actions.ts:177-203`). That file is absent from T5b scope.
   Plan fix: add a typed complete replacement view—text including the mode line plus action affordances—to `MessageActionOutcome`; scope `domain/message-actions.ts`. Providers should consume that view rather than reconstruct session-layer content.

7. Discord cannot perform the promised source-message edit through the cited path.
   Evidence: the current acknowledgment is an immediate ephemeral type-4 response (`apps/core/src/channels/discord/interaction-helpers.ts:60-64`), and the later PATCH updates that ephemeral `@original` response (`:71-88`), not the tapped list message. The source edit port exists only behind `messageMutations.edit` in `discord/index.ts:188-205`.
   Plan fix: specify a type-6 deferred message update followed by source-message PATCH and an ephemeral follow-up receipt, or inject the source-message mutation port and use the interaction message ID. Add the required helper files and exact ordering test to scope.

8. The `memoryUserLabel` ruling names the wrong host seams and omits the actual registry path.
   Evidence: `runtime-services-active-new.ts:26-57` handles only active `/new`; `runtime-app.ts:546-570` clears sessions. Normal AgentInput construction is in `group-agent-runner.ts:535-545`, while the trusted run registry is `agent-spawn-permission-run-restriction.ts:21-53` and `permission-decision-coordinator.ts:527-555`. The canonical resolver reads `sender_name` but returns only the ID (`group-person-identity.ts:136-147,181-205`).
   Plan fix: define one host-derived `{ personId, label }` carrier and thread it through `GroupProcessOptions` → group processing → group-agent-runner → AgentInput → permission-run restriction; IPC consumes only that registry label, while inline consumes AgentInput. Add all those files and source-spoof tests to scope.

9. The scheduler extraction is not a pure 65-line move or a ≤6-line binding.
   Evidence: the block closes over process role, app, queue, channel wiring, lifecycle updater, browser closures, execution adapters, and numerous repository getters (`apps/core/src/app/bootstrap/runtime-services.ts:372-434`).
   Plan fix: name a `createRuntimeSchedulerStarter` contract with exact narrow dependency picks and revised source-line estimates; account for its imports/types and caller wiring before claiming the 1,186-line cap is satisfied.

10. The audit scan relies on an unsupported retention premise.
    Evidence: `permission_decisions` declares neither an audit-retention boundary nor a JSON-expression index (`apps/core/src/adapters/storage/postgres/schema/permissions.ts:42-60`); the adapter currently only saves and reads by primary ID (`domain-repositories.postgres.ts:1808-1874`). The plan nevertheless justifies the scan as retention-bounded (`plans/exploration/askfloor-1-t5b-taskplan.md:16`).
    Plan fix: add a migration for an app/record/job/created-at expression index, or record an owner decision explicitly accepting an unbounded table scan and remove the retention claim.

11. Ruling 6 names a nonexistent adapter file and misses one mandatory caller.
    Evidence: the scoped `permission-decision-memory.postgres.ts` does not exist (`plans/exploration/askfloor-1-t5b-taskplan.md:48`); the live adapter is `permission-decision-memory-repository.postgres.ts:215`. `rememberDerived` also calls `listHumanDecisions` directly without railVersion (`human-decision-memory-service.ts:160-164`).
    Plan fix: correct the path, add mandatory `railVersion` to the port/adapter, update both service call sites, and explicitly assign an integration test proving SQL exclusion of old-version rows.

12. The plan exceeds the grill’s authorized scope and budget before these repairs.
    Evidence: the brief asks verification against 35 files and 40/4,000 (`plans/exploration/askfloor-1-t5b-task-grill-brief.md:7`); v2 declares 46 files and 50/4,500 (`plans/exploration/askfloor-1-t5b-taskplan.md:48`). Missing carrier, output-contract, route, migration, and compile-fake files increase it further.
    Plan fix: either re-bound to 40 files/4,000 lines or obtain and ledger owner approval for a newly enumerated scope/budget, then update the brief and decomposition consistently.

NON-BLOCKING

- The existing canonical-person resolver is reachable and correctly DM-gated (`group-processing-session-command-handlers.ts:63-67`; `group-person-identity.ts:181-192`).
- The grouped JSON read itself is feasible: audit context contains both `jobId` and supplied metadata (`permission-decision-audit.ts:53-63`), and job-name hydration exists (`ops-repo.ts:221-225`).
- Telegram, Slack, and Teams retain usable local source-message handles and edit APIs; the host action input need not carry their message IDs.
- The story spec still contains withdrawn rails-version re-ask copy (`docs/specs/askfloor-1-judge-actually-judges.md:32,72`), but accepted Decision 0154’s Amendment supersedes it (`docs/decisions/0154-human-decision-memory-generic-scope.md:24-26`).

NOT CLEAN
