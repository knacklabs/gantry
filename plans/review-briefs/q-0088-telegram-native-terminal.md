# Review brief — lite window Q-0088 (Telegram renders the terminal edit natively)

Facts: the terminal notice edits the running card with markdown text; on Telegram the MarkdownV2 ladder frequently falls to plain text, leaving literal `**` around the header (screenshot 2026-08-26). The structured JobNotificationView now rides on the edit (Q-0087) and Telegram already has a native renderer (telegramJobNotificationMessage: HTML header, stats, expandable blockquote with headline/items/next action, next-run line) used by the fallback send.

Contract for this diff:
- `sendProgressUpdate` with `done && jobNotificationView` renders via telegramJobNotificationMessage and edits/sends with parse_mode HTML, attaching the same action reply_markup as today; the view is the whole message (no appended markdown text).
- On an HTML parse failure the sink falls back to the existing text path (a bad view never loses the notice).
- Terminal HTML sends (no handle, or replacement after a non-parse edit failure) carry the forum thread id and reply markup like the text path; an over-length rendered view uses the existing text path.
- Everything else unchanged: generation gate, 'Done.' clear, unchanged-text dedupe (on the rendered HTML), handle persistence, non-terminal updates, updates without a view.

Focus: the edit must target the same running-card message id (no new message when the handle exists), unchanged-text dedupe must not suppress a legitimately changed view, and length (header + 10 items + summary) must respect TELEGRAM_MESSAGE_MAX_LENGTH with the existing split/fallback behavior. Ignore style.
