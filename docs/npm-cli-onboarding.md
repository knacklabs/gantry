# MyClaw npm Onboarding

## Install And Run

Use npm directly (no repo clone needed):

```bash
npx myclaw
```

Optional global install:

```bash
npm install -g myclaw
myclaw
```

## First Run Flow

The first run is Telegram-first and guided one step at a time:

1. welcome
2. machine doctor
3. runtime home confirmation (`~/myclaw` by default)
4. runtime prerequisite check
5. Telegram token + chat connection
6. memory decision
7. embeddings decision
8. dreaming decision
9. config write
10. Telegram group registration
11. optional service install/start
12. final verification
13. ready screen

If setup is interrupted, rerun `myclaw` to resume.

Slack can be connected after first-run setup (or as an additional channel) with `myclaw slack connect`.

## Runtime Home

MyClaw stores mutable state under `AGENT_ROOT`.

Default path:

```text
~/myclaw
```

Contains:

- `.env`
- `settings.yaml`
- `store/`
- `agents/`
- `data/`
- `logs/`
- `.onboarding-state.json`

`settings.yaml` is the single user-editable runtime settings file for behavior flags and message policy (including sender allowlist).

Override at runtime:

```bash
myclaw --runtime-home /path/to/runtime
```

## Telegram Setup

Required values:

- Telegram bot token from BotFather
- Telegram chat ID (for example `-1001234567890`)

Reconnect Telegram later:

```bash
myclaw telegram connect
```

## Slack Setup

Required values:

- Slack Bot User OAuth token (`SLACK_BOT_TOKEN`, starts with `xoxb-`)
- Slack App-level token (`SLACK_APP_TOKEN`, starts with `xapp-`, `connections:write`)
- Slack chat/channel ID (for example `C0123456789`, stored as `sl:C0123456789`)

Connect or reconnect Slack:

```bash
myclaw slack connect
```

## Memory Settings (Beginner Language)

- Memory: remember useful context between chats.
- Embeddings: improve memory search quality using OpenAI.
- Dreaming: background memory cleanup and improvement.

Default choices:

- memory: on
- embeddings: off
- dreaming: off

## Service Management

Install service:

```bash
myclaw service install
```

Start service:

```bash
myclaw service start
```

Stop service:

```bash
myclaw service stop
```

## Useful Commands

```bash
myclaw doctor
myclaw status
myclaw start
```

## Troubleshooting

### Telegram token fails validation

Next action:

1. verify token in BotFather
2. paste full token again
3. rerun `myclaw telegram connect`

### Slack tokens fail validation

Next action:

1. verify `SLACK_BOT_TOKEN` starts with `xoxb-` and app is installed to workspace
2. verify `SLACK_APP_TOKEN` starts with `xapp-`, Socket Mode is enabled, and token has `connections:write`
3. invite the app/bot to the target channel
4. rerun `myclaw slack connect`

### Runtime home is not writable

Next action:

1. choose a different runtime home
2. or fix permissions on the selected folder

### Runtime mode check

MyClaw uses host runtime execution. If doctor reports runtime issues, resolve Node/runtime-home/credentials warnings and rerun `myclaw doctor`.
