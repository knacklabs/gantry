# UX duplicate audit, 2026-10-02

Read-only Codex audit (gpt-6.1-sol, high) of every provider for duplicate, parallel or unwanted user-facing behaviour.

Found **eight uncovered UX issues**. This was read-only; claims below come from current code. Teams’ built-in client [returns null]( /Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/teams/sdk-client.ts:3), so its copies are dormant scaffolding.

Already covered:

- Multiple permission formats, button sets and approval receipts — **covered by PERMFLOW-1**.
- Parallel saved-approval stores and person-only permission listings — **covered by PERMFLOW-2**.
- Job permission/setup cards, job-only controls, running cards, recovery/retry/capacity/judge-offline chatter — **covered by PERMFLOW-3/4**.
- Provider-specific delivery, streaming, retry and restart machinery; unfinished Teams transport — **covered by MSG-2/4**.

1. **Forms collect answers that never reach the agent. — Medium**

   Users can open a second input surface through `render_form`. Slack discards the submitted values and posts “Submitted by …”; Discord also acknowledges submission without reading values.

   Copies: [tool registration](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/runner/mcp/tools/messaging.ts:298), [Slack submission](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/slack/rich-interaction.ts:480), [Discord submission](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/discord/interactions.ts:382), [Telegram form rendering](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/telegram/rich-interaction.ts:12), [Teams form rendering](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/teams/rich-interaction.ts:31), [App descriptor publication](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/app.ts:255).

   **Survive:** the existing question/answer interaction, which returns answers to the waiting agent. **Delete:** `render_form`, its guidance, and form-only modal/submission branches. Preserve the other rich views.

2. **A plan and a progress line become separate messages for the same work. — Medium**

   `todo_update` and `render_progress` use the same renderer but different message identities. Calling both creates two independently updated surfaces.

   Entry points: [todo handler](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts:309), [progress conversion](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/runtime/ipc-rich-interaction-processing.ts:74), [shared identity includes card kind](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/app/bootstrap/channel-wiring-interactions.ts:370). Separate provider identities: [Telegram](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/telegram/agent-todo-delivery.ts:78), [Slack](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/slack/channel-delivery.ts:192), [Discord](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/discord/index.ts:453), [Teams](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/teams/todos.ts:26).

   **Survive:** one plan/progress surface containing the meaningful current step. **Delete:** the separate `progress` identity and standalone progress-tool surface. MSG centralizes delivery but does not choose between these two visible products.

3. **Every non-trivial request is instructed to produce an extra acknowledgement. — Small**

   Gantry explicitly tells agents to send a preliminary message before investigating, even though ambient liveness already exists. This is prompt-directed behaviour, not a guaranteed message on every execution.

   Copies: [full and locked defaults](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/application/agents/prompt-profile-defaults.ts:31), [second default copy](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/application/agents/prompt-profile-defaults.ts:41), [operating guidance](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/application/agents/prompt-profile-service.ts:192), [communication exception](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/application/agents/prompt-profile-service.ts:233).

   **Survive:** ambient liveness, substantive updates and the answer. **Delete:** the mandatory acknowledgement instruction and its exception. Neither plan explicitly removes this instruction.

4. **Telegram’s “Other” button adds another prompt every time it is tapped. — Small**

   The original question remains, a new “Reply to this message with your answer” message appears, and a popup also says “Reply with your answer.” Repeated taps create more prompt messages. Answer settlement edits the original question, leaving these helper messages.

   Locations: [button](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/telegram/channel-prompts.ts:123), [extra message and popup](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/telegram/callback-handlers.ts:335), [reply resolution](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/telegram/channel-prompts.ts:520), [original-question settlement](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/telegram/channel-prompts.ts:470).

   **Survive:** the original question as the sole reply target. **Delete:** the additional free-text prompt messages and redundant popup; accept an authorized direct reply to the original question.

5. **Question options appear twice: in the message and again on buttons. — Small**

   Telegram, Slack and Discord repeat each option label in both the explanatory list and the controls.

   Copies: Telegram [body](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/telegram/html-render.ts:113) / [buttons](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/telegram/channel-prompts.ts:90); Slack [body](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/slack/channel-user-question-utils.ts:82) / [buttons](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/slack/channel-state.ts:244); Discord [body](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/discord/user-question-delivery.ts:113) / [buttons](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/discord/components.ts:145).

   **Survive:** the numbered explanatory list, because it contains descriptions. **Delete:** repeated labels from buttons; use numbered selection controls. Text-only delivery retains the list.

6. **Session controls have three advertised spellings. — Medium**

   Users are offered `/stop`, `/gantry stop` and `!stop`, likewise for fresh sessions, compaction, models and settings. Help itself also accepts `!help`.

   Copies: [bang-command parser](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/session/session-command-parse.ts:107), [envelope parser](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/session/session-command-parse.ts:175), [direct-command parser](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/session/session-command-parse.ts:195), [advertised alternatives](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/session/session-command-help.ts:4). Native entry points: [Telegram](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/telegram/bot-setup.ts:28), [Slack](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/slack/channel-interactions.ts:332), [Discord](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/discord/interactions.ts:396).

   **Survive:** one text-command grammar, preferably `!…`, which works where native slash commands cannot target threads. **Delete:** the other advertised grammars, parser branches and native command registrations.

7. **Discord sends a command receipt before sending its result. — Small**

   `/gantry new`, for example, first produces the private “Gantry received /new” message, then the shared “Started a fresh session” result.

   Copies: [preliminary receipt](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/discord/interactions.ts:398), [visible ephemeral response](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/discord/interaction-helpers.ts:49), [idle result](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/session/session-commands.ts:321), [active result](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/app/bootstrap/runtime-services-active-new.ts:145).

   **Survive:** the actual command outcome. **Delete:** the receipt text; retain the required Discord protocol acknowledgement without a second enduring message.

8. **Text fallback announces internal rendering machinery. — Small**

   Users receive “Rich view unavailable in this conversation. Showing text version” before otherwise usable content.

   Copies: [shared wording](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/domain/types.ts:445), [host fallback](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/runtime/ipc-rich-interaction-processing.ts:94), provider fallbacks in [Telegram](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/telegram/rich-interaction.ts:56), [Slack](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/slack/rich-interaction.ts:401), [Discord](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/discord/rich-interaction.ts:133), [Teams](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/channels/teams/rich-interaction.ts:110).

   **Survive:** the useful text fallback. **Delete:** the diagnostic preface. MSG covers delivery consolidation, not this wording.

Ranked by user impact:

1. Forms that discard answers.
2. Mandatory preliminary acknowledgements.
3. Separate plan/progress messages.
4. Telegram’s accumulating “Other” prompts.
5. Repeated question options.
6. Three command grammars.
7. Discord’s extra command receipt.
8. Rendering diagnostics in fallback text.
