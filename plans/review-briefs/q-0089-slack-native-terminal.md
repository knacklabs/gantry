# Review brief — lite window Q-0089 (Slack renders the terminal edit natively)

Facts: the structured JobNotificationView rides on the lifecycle terminal edit (Q-0087); Telegram renders it natively (Q-0088). Slack's progress sink (sendSlackProgressUpdate) still updates the running card with markdown text; slackJobNotificationBlocks already renders the view for the fallback send.

Contract for this diff:
- `sendProgressUpdate` with `done && jobNotificationView` updates the running card (chat.update) — or posts once when no handle exists — with blocks = slackJobNotificationBlocks(view) followed by the existing action blocks, and `text` = the summary fallback for notifications/accessibility; the view is the whole message.
- On a Slack API rejection of the blocks, fall back to the existing text update (never lose the notice).
- Unchanged: generation gate, handle persistence, unchanged-content dedupe (keyed on a stable serialization of the blocks), non-terminal updates, updates without a view.

Focus: the update must target the same ts (no new message when a handle exists); block count/size within Slack limits (50 blocks, 3000 chars per section); action blocks must keep their action ids; a fallback text update after rejection must still carry the actions. Ignore style.
