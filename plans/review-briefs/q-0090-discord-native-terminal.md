# Review brief — lite window Q-0090 (Discord renders the terminal edit natively)

Facts: the structured JobNotificationView rides on the lifecycle terminal edit (Q-0087); Telegram (Q-0088) and Slack (Q-0089) render it natively. Discord's progress sink (sendDiscordProgressUpdateForRoute via discord.ts sendProgressUpdate) still edits the running card with markdown text; discordJobNotificationEmbed already renders the view for the fallback send.

Contract for this diff:
- `sendProgressUpdate` with `done && jobNotificationView` edits the running card (or posts once when no handle exists) with `embeds: [discordJobNotificationEmbed(view)]` and a minimal content body, keeping action components attached exactly as today; the view is the whole message.
- If the edit path cannot carry embeds yet, its callback is extended minimally (body + optional embeds) — never a second message.
- Fallback fires only when Discord's structured error identifies the `embeds` payload; every other error (other 400 fields, transport, auth, rate-limit) is rethrown (post-once). The fallback edit sends `embeds: []` so a previously applied terminal embed cannot linger beside the text.
- Unchanged: identity lifecycle, control-key handling, delete-on-clear, non-terminal updates, updates without a view.

Focus: the edit must target the same message id; embed field limits (25 fields, 1024 chars per value, 6000 total) with the existing truncation; components must remain on the edited message; dedupe must not suppress a legitimately changed view. Ignore style.
