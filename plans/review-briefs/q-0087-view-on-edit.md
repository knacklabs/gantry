# Review brief — lite window Q-0087 (structured terminal view rides on the lifecycle edit, all providers)

Owner direction: fixes must be neutral across jobs and providers. The terminal notice is ONE message per route: the running card edited in place. Today the edit carries only markdown text; the structured JobNotificationView (headline/items/nextAction/stats/nextRunAt) reaches native renderers only on the fallback send, so users see plain progress text (literal `**` on Telegram when the MarkdownV2 ladder falls to plain).

Contract for this diff (plumbing only):
- `ProgressUpdateOptions.jobNotificationView` exists; execution-notifications passes the already-built bounded view into `updateLifecycleNotification`, which forwards it on every terminal send (identity edit, fresh fallback, late-landing summary edit) and never on the 'Done.' clear.
- No provider renders it yet (follow-up windows: Telegram, Slack, Discord). Providers ignoring the option behave exactly as before.
- No change to generations, idempotency memo, affordances, or outcome semantics from Q-0080/Q-0084.

Focus: the view must be the same bounded object used by the native fallback (no second construction), must not be mutated between routes, and the late-landing edit must use the captured view, not a stale one. Ignore style.
