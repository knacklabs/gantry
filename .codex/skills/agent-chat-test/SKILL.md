---
name: agent-chat-test
description: Drives Gantry agent-chat tests through the local Control API session path and captures assistant responses. Use when testing an agent response, permission prompt, skill behavior, or runtime chat flow without needing Telegram UI rendering.
---

# Agent Chat Test

Use this skill when the goal is to send a test message to a Gantry agent and
inspect the runtime response. Prefer this over `telegram-agent-loop` unless the
thing being tested is specifically Telegram UI rendering, Telegram buttons, or
visible Telegram topic behavior.

## Quick Start

```bash
node .codex/scripts/agent_chat_test.mjs --fresh "Ask a short status question and reply in one sentence."
```

The script sends through Gantry's app/session Control API. This exercises the
real session enqueue path, runtime queue, permission handling, and outbound
session events without direct Postgres writes.

## Workflow

1. Build/restart first when validating local code changes:
   ```bash
   npm run build
   node dist/cli/index.js service restart
   node dist/cli/index.js status
   ```
2. Send a focused test message:
   ```bash
   node .codex/scripts/agent_chat_test.mjs --fresh "Use the LinkedIn posting skill to draft a harmless test post, then stop before publishing."
   ```
3. Read the script output:
   - `Session` identifies the app session used for the test.
   - `Conversation` identifies the app conversation.
   - `Accepted message` proves the message was durably accepted.
   - The final text is the assistant response captured from session events.
4. If the response is wrong, inspect runtime evidence before changing code:
   ```bash
   node dist/cli/index.js status
   tail -n 200 ~/gantry/logs/gantry.log
   ```

## Options

- Use `--conversation-id codex-test-name` to reuse a stable test conversation.
- Use `--fresh` to avoid stale session context by appending a timestamp.
- Use `--thread-id <id>` only when testing thread-scoped behavior.
- Use `--json` when another script needs structured output.
- Use `--timeout-ms <ms>` to shorten or lengthen the wait, up to 300000 ms.

## Boundaries

- This does not test Telegram message formatting, Telegram buttons, or
  Telegram topic routing. Use `telegram-agent-loop` for those cases.
- Do not use this skill to bypass user permission decisions. If the agent
  requests permission, verify the product prompt and approval persistence path.
- Do not write directly to Postgres to simulate chat. The Control API is the
  supported local test ingress.
