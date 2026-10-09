# Provider API review, 2026-10-02

This review compares what each chat provider's official API offers today with what Gantry uses. It was done by a research agent on 2026-10-02 and checked against the code at that date. Each claim links to the provider's documentation.

## Why Telegram direct-message streaming never ran (#544)

- **The gate.** `telegramProvider.canStreamToJid = jid.startsWith('tg:-')` (register-builtins.ts:147) allows streaming only in groups. So the private-chat draft branch was never called. The gate came in 91db8d57f (2026-05-10), and no reason was recorded.
- **The deletion.** #544 then deleted the unreachable code.
- **Not the API.** `sendMessageDraft` has been open to all bots since Bot API 9.5 (2026-03-01).
- **A likely reason for the gate.** A draft is a 30-second ephemeral preview, so it vanishes during long tool runs unless it is refreshed.

## Telegram

- **We use:**
  - grammY long polling;
  - group streaming by edits every 950 ms;
  - `sendChatAction` typing, which lasts 5 s or less;
  - reactions and inline keyboards.
- **We don't use:**
  - **Drafts.** `sendMessageDraft` (Bot API 9.3, open to all bots in 9.5) works in private chats only. It is an animated draft that lasts 30 s and is finished with `sendMessage`. Bot API 10.3 (2026-08-24) adds `can_stop` / `keep_on_stop`, a native Stop button, and the `stopped_message_generation` update. https://core.telegram.org/bots/api#sendmessagedraft, https://core.telegram.org/bots/api-changelog
  - **Rich messages.** `sendRichMessageDraft` (10.1). https://core.telegram.org/bots/api#sendrichmessagedraft
  - **Button colours.** `InlineKeyboardButton.style` can be danger, success or primary (9.4). `DisabledButton` arrived in 10.3. https://core.telegram.org/bots/api#inlinekeyboardbutton
- **Limits:** 1 message/s per chat, 20/min in a group and about 30/s globally. https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
- **Polling vs webhooks:** updates are kept 24 hours either way, so polling stays. https://core.telegram.org/bots/api#getting-updates

## Slack

- **We use:**
  - Socket Mode;
  - native `chat.startStream` / `appendStream` / `stopStream`, in threads only;
  - `assistant.threads.setStatus`;
  - a 550 ms flush for both native append and the `chat.update` fallback.
- **Limits:**
  - `chat.update` is Tier 3, about 50/min. https://docs.slack.dev/reference/methods/chat.update/
  - `appendStream` is Tier 4, about 100/min per app per workspace. https://docs.slack.dev/reference/methods/chat.appendStream/
  - 550 ms is about 109 per minute for a single stream, which is too fast.
- **We don't use:**
  - **Top-level streaming.** `thread_ts` is optional; a channel stream needs `recipient_user_id` and `recipient_team_id`. https://docs.slack.dev/reference/methods/chat.startStream/
  - **Progress chunks.** Task-update and plan chunks render progress natively.
  - **Agent sessions** (2026-08-20). `agents.sessions.setStatus` plus the `agent_session_stopped` event give a native Stop button. `assistant_view` is deprecated in February 2027. https://docs.slack.dev/changelog/2026/08/20/agent-updates/, https://docs.slack.dev/ai/agent-sessions/
  - **Status scope.** Since 2026-03-05, `setStatus` works with `chat:write` and in channel threads. https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/
- **Delivery:** Socket Mode envelopes must be acknowledged, or Slack retries them. https://docs.slack.dev/apis/events-api/using-socket-mode/

## Discord

- **We use:**
  - a raw gateway with resume;
  - edits every 1200 ms;
  - typing, which lasts 10 s;
  - classic button rows.
- **Gaps:**
  - **Resume address.** We resume on the original URL, not `resume_gateway_url`. Discord says that causes more disconnects. https://docs.discord.com/developers/events/gateway
  - **Duplicate sends.** We send no `nonce` with `enforce_nonce`, so a retried send can post twice. https://docs.discord.com/developers/resources/message
  - **Components v2** (`IS_COMPONENTS_V2`). https://docs.discord.com/developers/components/reference
  - **No streaming API exists.** https://docs.discord.com/developers/change-log
- **Limits:** per-route limits come from the response headers; the global limit is 50/s. https://docs.discord.com/developers/topics/rate-limits

## Teams (not built)

- **Streaming:** 1:1 chats only, 1 request/s, a 1.5–2 s buffer, at most 2 minutes, and a built-in Stop. https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux
- **Rate limits.** https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit

## WhatsApp (not built)

- **Typing and read receipts:** typing lasts 25 s. https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
- **Buttons:** at most 3 reply buttons. https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages/
- **Rate limit:** 1 message every 6 s to the same user. https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/
- **Webhooks:** retried for up to 7 days. https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/
