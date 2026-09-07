# ASKFLOOR-1-T3c task-contract grill — round 4 answer (gpt-5.6-sol @ xhigh)

1. **IPC persists `rememberContext` too late.**  
   **Where:** [task plan:9](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:9), [ipc-permission-classifier-decision.ts:599](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/runtime/ipc-permission-classifier-decision.ts:599), [prompt-binding.ts:36](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/channels/telegram/prompt-binding.ts:36).  
   **Why:** the plan attaches context only after `requestPermissionApproval` returns, but prompt binding and the provider claim happen during that awaited call. Binding therefore cannot finalize `eligible`, and a crash after claim but before helper return leaves recovery with a code but no context.  
   **Minimal fix:** persist provisional context through a pre-prompt callback before the provider binding becomes actionable; let binding finalize it, and add a recovery test for the exact claim-before-helper-return crash window.

2. **The durable DTO discards required refusal reasons.**  
   **Where:** [task plan:9](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:9), [task plan:11](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:11), [human-decision-scope.ts:22](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/application/permissions/human-decision-scope.ts:22).  
   **Why:** candidates are stored as `{ scopeKey } | null`, but `null` can mean `no_root`, `no_category`, `protected_destination`, or `incomplete_effect`. AC3 requires the original T3a reason without settlement re-derivation, which is impossible after reducing all failures to `null`.  
   **Minimal fix:** persist each candidate as a discriminated success/refusal result, including its typed reason, and test every refusal route.

3. **The control-API carrier contract is incomplete.**  
   **Where:** [task plan:15](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:15), [decomposition.json:767](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/decomposition.json:767), [session-interaction-approvals.ts:48](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/control/server/session-interaction-approvals.ts:48), [sessions.ts:261](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/control/server/routes/sessions.ts:261).  
   **Why:** the contract says the API exposes a scalar base plus remember intent, but the GET and POST contracts carry only three scalar strings. Several remember codes collapse to `allow_once`, so the implementer cannot determine which raw code the client selected; the route needed to accept a distinct code/intent is outside the scope.  
   **Minimal fix:** define the exact external option and response DTO and add the route plus route test to scope, or explicitly declare the control API scalar-only and remove the “plus intent” promise.

4. **The governing documents still prescribe incompatible implementations.**  
   **Where:** the story plan requires settlement lane re-derivation at [story plan:160](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md:160) and [story plan:192](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md:192); the saved plan repeats fresh re-derivation and calls `remember` at [task plan:4](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:4), while ruling 3 forbids settlement derivation and ruling 5 requires `rememberDerived` at [task plan:9](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:9). The Scope also says “type move” at [task plan:18](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:18), contradicting ruling 1’s “no type move.”  
   **Why:** an implementer must choose which contract to violate.  
   **Minimal fix:** if the round-4 ruling governs, amend the story-plan T3c sentences and saved-plan Context/Scope to say host-stamped context, `rememberDerived`, and line-neutral widening, then regenerate the decomposition contract.

5. **The four-provider forgery guarantee has no owning proof.**  
   **Where:** [task plan:8](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:8) excludes every handler, while current Telegram, Slack, Discord, and Teams parsers reject remember codes before scalar settlement—for example [Telegram:707](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/channels/telegram/callback-handlers.ts:707), [Slack:358](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/channels/slack/channel-interactions.ts:358), [Discord:142](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/channels/discord/components.ts:142), and [Teams:24](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/channels/teams/permission-submit.ts:24).  
   **Why:** T3c’s leaves prove the common recovery path and only the Telegram/Slack codecs, not that an authorized forged code settles as its scalar base on every provider.  
   **Minimal fix:** keep handler files out of T3c, narrow T3c’s guarantee to the shared durable seam, and explicitly assign the four-provider unauthorized/ineligible/double-delivery matrix to T5a.

Non-blocking notes:

- The six saved-plan AC bodies, decomposition ACs, and `plan_contracts` statements are byte-equal.
- The scope contains 33 files—20 source and 13 tests—within the 36-file/3,600-line budget.
- All twelve leaf titles are valid literal Vitest patterns. Existing test paths exist; the three missing paths are explicitly NEW.
- The corrected production-wiring leaf points to the existing `test/unit/storage/runtime-store.test.ts`.
- Current ceilings are correctly recorded: IPC 865, inline 745/750, and `domain/types.ts` 740; the proposed layer directions are allowed.
