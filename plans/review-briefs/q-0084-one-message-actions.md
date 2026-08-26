# Review brief — lite window Q-0084 (one terminal message even when action buttons are needed)

Facts: the terminal path edits the running card (updateLifecycleNotification) and then, when run-again/recovery actionAffordances exist (manual jobs or limited completion), ALSO sends a native notification to the full job routes — two messages. `ProgressUpdateOptions.actionAffordances` already exists and the Telegram progress edit renders it as an inline keyboard (progress-message-actions.ts). Owner rule: exactly one terminal message per run per route.

Contract for this diff:
- `updateLifecycleNotification` accepts `actionAffordances` and forwards them on every terminal send it makes for that update (identity replaceOnly edit, fresh fallback done send, late-landing summary edit — captured alongside terminalSummary). The 'Done.' clear never carries them.
- execution-notifications passes the affordances into the lifecycle update and sends the native notification ONLY to routes the update did not reach (jobForLifecycleFallback), regardless of whether affordances exist.
- The native fallback still carries the affordances + structured view (unchanged) for the routes it serves.
- No change to generations, idempotency memo, or the outcome semantics from Q-0080.

Focus: a route that is 'updated' by the edit must never also receive the native message; affordance identity/tokens on the edited card must be the same ones the action router expects (no re-minting between edit and fallback); late-landing summary edit must carry the captured affordances, not stale ones. Ignore style.
