# Review brief — lite window Q-0083 (one completion message that carries the tool outcome lines)

Facts: the terminal notice edits the running card with `summaryMessage` (formatRunStatusMessage, markdown). The ✅/❌ tool outcome lines lived only in the native `jobNotificationView` render, which now fires only as a fallback when the edit did not land (sendJobNotification via jobForLifecycleFallback). Users saw the rich list only when the running card had been dropped by the (now fixed) generation bug. Product rule from the owner: ONE message.

Contract for this diff:
- formatRunStatusMessage renders the structured outcome items (same items the native view shows, same 10-item bound with the rollup's '+N more') between the stats line and the summary, when provided; unchanged output when not provided.
- execution-notifications computes the rollup once and feeds the items into the summary; the native fallback view is unchanged.
- Memory-dreaming system jobs keep their deliberately compact terminal message (compactMemoryDreamingTerminalMessage) BY DESIGN — owner rule 'no status clutter in chat'; do not propose adding outcome items there.
- Markdown escaping BY DESIGN: the Telegram send/edit helpers (channel-shared.ts sendTelegramMessageWithResult / editTelegramMessage) apply a ladder — raw MarkdownV2, then the escaped text on parse failure, then plain text — so metacharacters cannot make the edit fail; item labels (our humanized tool names) and details (host domains) ride the same ladder as the existing free-text summary excerpt. Pre-escaping in the formatter would double-escape on the retry. Do not propose formatter-side escaping.
- No change to delivery paths, generations, or the lifecycle state machine.

Focus: message length against Telegram's edit limits (header + 10 items + summary excerpt + next-run must stay well under 4096 chars; the summary excerpt is already compacted), markdown-escaping of item labels/details in the progress edit path, and duplicate rendering when the native fallback DOES fire (it renders result items itself and uses the summary only as fallbackText — confirm no double list). Ignore style.
