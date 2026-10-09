Read-only audit: **7 findings**. No files changed. The named UX-1 and PROV spec files are absent from this checkout; I used your descriptions to exclude their scope.

1. **Session commands mistake control frames for completion — duplicate**

   **Experience:** When processing messages before a session command, a successful frame with no text closes input—even a startup, compaction or interaction frame.

   **Locations:** The command-specific check is [session-commands.ts:340](../../../../apps/core/src/session/session-commands.ts#L340). The shared predicate excludes those frames at [agent-output-callbacks.ts:23](../../../../apps/core/src/runtime/agent-output-callbacks.ts#L23); ordinary turns use it at [group-processing.ts:555](../../../../apps/core/src/runtime/group-processing.ts#L555). A real startup frame has `result: null` and `runtimeEventOnly: true` at [query-loop-phases-messages.ts:126](../../../../apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-messages.ts#L126).

   **Survive/delete:** Keep the shared completion predicate and follow-up handling; replace the command-only check.
   **Size:** Small.
   **Risk:** Preserve genuine completion and continuation behavior.

2. **Stopping the same runner follows different termination policies — parallel**

   **Experience:** `/stop` sends SIGTERM without escalation. Abort escalates after five seconds. Timeout immediately sends SIGKILL. A runner ignoring SIGTERM therefore has no bounded shutdown through `/stop`.

   **Locations:** [group-queue-stop.ts:31](../../../../apps/core/src/runtime/group-queue-stop.ts#L31), [agent-spawn-process-abort.ts:36](../../../../apps/core/src/runtime/agent-spawn-process-abort.ts#L36), and [agent-spawn-process.ts:187](../../../../apps/core/src/runtime/agent-spawn-process.ts#L187). The scheduled idle timeout repeats the immediate kill at [agent-spawn-process.ts:272](../../../../apps/core/src/runtime/agent-spawn-process.ts#L272).

   **Survive/delete:** Keep one runner termination mechanism, including process-group signaling and bounded escalation. Merge the repeated signaling code; retain separate stop, abort and timeout outcomes.
   **Size:** Small.
   **Risk:** Signal descendants correctly and clear escalation timers when the process exits.

3. **Compaction status has three authorities — over-complicated**

   **Experience:** Compaction can announce degraded memory extraction, while `/status` reports simply “ready.” The provider-ready flag wins before the durable task’s degraded outcome is read.

   **Locations:** In-memory admission state: [session-compaction-command.ts:27](../../../../apps/core/src/session/session-compaction-command.ts#L27). Durable task admission: [group-session-command-state.ts:170](../../../../apps/core/src/runtime/group-session-command-state.ts#L170). Provider-state-first status: [group-session-command-state.ts:337](../../../../apps/core/src/runtime/group-session-command-state.ts#L337). Task outcome translation: [group-session-command-state.ts:406](../../../../apps/core/src/runtime/group-session-command-state.ts#L406). Another in-memory status fallback: [session-commands.ts:540](../../../../apps/core/src/session/session-commands.ts#L540). Degraded outcomes are stored and announced at [session-compaction-command.ts:169](../../../../apps/core/src/session/session-compaction-command.ts#L169).

   **Survive/delete:** Keep the durable task as the operation’s status and admission authority. Keep provider maintenance state as a lock; remove its role as an overriding user-visible status and remove the in-memory fallback lane.
   **Size:** Medium story.
   **Risk:** Preserve maintenance locking, stale-task recovery and ready-context promotion.

4. **`/new` implements session-boundary capture twice — duplicate**

   **Experience:** Developers maintain separate capture/reset/archive sequences depending on whether a run is active, with different failure wording and provider-selection wiring.

   **Locations:** Active implementation: [runtime-services-active-new.ts:91](../../../../apps/core/src/app/bootstrap/runtime-services-active-new.ts#L91), including its archive launch at line 133. Queued implementation: [session-commands.ts:295](../../../../apps/core/src/session/session-commands.ts#L295), [group-session-command-state.ts:78](../../../../apps/core/src/runtime/group-session-command-state.ts#L78), and [session-new-archive.ts:31](../../../../apps/core/src/session/session-new-archive.ts#L31). Both remain wired through [runtime-services.ts:695](../../../../apps/core/src/app/bootstrap/runtime-services.ts#L695) and [group-processing-session-command-handlers.ts:160](../../../../apps/core/src/runtime/group-processing-session-command-handlers.ts#L160).

   **Survive/delete:** Keep capture-before-reset and asynchronous extraction from the captured session. Reuse that sequence for active resets; retain the active path’s necessary stop step and truthful stop-related failure message.
   **Size:** Medium story.
   **Risk:** Never extract from the newly reset session.

5. **SDK resume status searches obsolete alternative shapes — over-complicated**

   **Experience:** Developers maintain a recursive, depth-limited search for assorted session and “artifact” keys to answer one boolean question.

   **Locations:** Alternative-field checks at [session-interaction-module.ts:705](../../../../apps/core/src/application/sessions/session-interaction-module.ts#L705), recursive search at [session-interaction-module.ts:717](../../../../apps/core/src/application/sessions/session-interaction-module.ts#L717). The supported object already requires `externalSessionId` at [sessions.ts:33](../../../../apps/core/src/domain/sessions/sessions.ts#L33), populated directly by [session-repositories.postgres.ts:366](../../../../apps/core/src/adapters/storage/postgres/repositories/session-repositories.postgres.ts#L366).

   **Survive/delete:** Check the canonical external session handle. Delete reference and arbitrary-metadata discovery.
   **Size:** Small.
   **Risk:** Status changes for malformed records; no supported alternate shape was found.

6. **Streaming sanitization is copied inside its own accumulator — duplicate**

   **Experience:** Fixing split internal tags or provider-handle redaction requires updating two nearly identical state machines.

   **Locations:** [session-resume-runtime.ts:213](../../../../apps/core/src/runtime/session-resume-runtime.ts#L213) and [session-resume-runtime.ts:252](../../../../apps/core/src/runtime/session-resume-runtime.ts#L252). Both are instantiated together at [group-output-buffer.ts:63](../../../../apps/core/src/runtime/group-output-buffer.ts#L63).

   **Survive/delete:** Keep the streaming sanitizer and bounded accumulator. Compose them for accumulated output, deleting the second sanitization implementation.
   **Size:** Small.
   **Risk:** Preserve whitespace, final carry flushing and repeated snapshot behavior.

7. **SDK sessions reimplement the shared thread queue key — duplicate**

   **Experience:** Developers have two identical encoders for the same queue identity.

   **Locations:** [session-interaction-module.ts:680](../../../../apps/core/src/application/sessions/session-interaction-module.ts#L680) and [thread-queue-key.ts:12](../../../../apps/core/src/shared/thread-queue-key.ts#L12). The SDK copy’s sole production call is [session-interaction-module.ts:469](../../../../apps/core/src/application/sessions/session-interaction-module.ts#L469).

   **Survive/delete:** Keep `makeThreadQueueKey`; delete the SDK implementation and use the shared function.
   **Size:** Small.
   **Risk:** Low; trimming and encoding match.

Already covered:

- **covered by PERMFLOW-3:** separate scheduled execution and job-specific idle monitoring, including [agent-spawn-scheduled-idle.ts:18](../../../../apps/core/src/runtime/agent-spawn-scheduled-idle.ts#L18).
- **covered by MSG-4:** local continuation delivery and its alternate routing path at [runtime-services.ts:520](../../../../apps/core/src/app/bootstrap/runtime-services.ts#L520).
- **covered by UX-1:** waiting/continuation progress messages at [group-progress-heartbeats.ts:83](../../../../apps/core/src/runtime/group-progress-heartbeats.ts#L83).
- **covered by TURN-1/T8:** in-memory retries at [group-queue.ts:593](../../../../apps/core/src/runtime/group-queue.ts#L593), overlapping periodic recovery at [live-execution.ts:571](../../../../apps/core/src/app/bootstrap/live-execution.ts#L571).
- **covered by progress-card Stop deletion:** initial action-only progress at [group-progress-heartbeats.ts:48](../../../../apps/core/src/runtime/group-progress-heartbeats.ts#L48).

**Ranked value:** 1 → 2 → 3 → 4 → 5 → 6 → 7. Completion, cancellation and truthful status come first; among cleanup-only items, the recursive fallback offers the largest straightforward deletion, followed by sanitizer duplication and the queue-key helper.
