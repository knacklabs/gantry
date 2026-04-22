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

The first run is guided and channel-agnostic:

1. welcome
2. runtime home confirmation (`~/myclaw` by default)
3. storage selection (`SQLite`; Postgres is not exposed in guided setup yet)
4. runtime prerequisite check
5. channel selection (`Telegram` or `Slack`)
6. provider token + chat/conversation connection
7. credential source mode selection (`env-only` default, optional OneCLI)
8. Claude auth selection (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) for credential modes that need local credentials
9. model selection (`Sonnet` recommended, optional `Opus`)
10. memory decision
11. embeddings decision (off by default; asks for OpenAI key only if enabled)
12. dreaming decision (on by default)
13. optional service choice
14. final review + `Create Runtime`
15. config write
16. group registration
17. optional service install/start
18. final doctor verification
19. ready screen that exits by default and starts the runtime only when explicitly selected

Doctor verification is intentionally last in first-run setup. A fresh runtime is expected to be incomplete until channel credentials, model credentials, memory settings, and the first group are written.

Until `Create Runtime`, Back, Resume Later, and Cancel are transactional: setup may save onboarding progress, but it does not enable channels or register a group. If setup is interrupted, rerun `myclaw` to resume.

Slack can still be connected later (or as an additional channel) with `myclaw slack connect`.

## Runtime Home

MyClaw stores mutable state under `MYCLAW_HOME`.

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

`settings.yaml` is the single user-editable runtime settings file for channel, storage, and memory behavior (including sender allowlist).

Override at runtime:

```bash
myclaw --runtime-home /path/to/runtime
```

## Telegram Setup

Required values:

- Telegram bot token from BotFather (`@BotFather` -> `/newbot`)
- Telegram chat ID (for example `-1001234567890`)
- For group chats, add the bot to the group and send a message before discovery; use admin rights or BotFather `/setprivacy` if the bot must see every group message.

Reconnect Telegram later:

```bash
myclaw telegram connect
```

## Slack Setup

Required values:

- Slack Bot User OAuth token (`SLACK_BOT_TOKEN`, starts with `xoxb-`)
- Slack App-level token (`SLACK_APP_TOKEN`, starts with `xapp-`, `connections:write`)
- Slack chat/channel ID (for example `C0123456789`, stored as `sl:C0123456789`)
- Slack app setup: create an app, add a bot user and message/conversation scopes, enable Socket Mode, reinstall after scope changes, then invite the app to the target channel or DM it once.

Connect or reconnect Slack:

```bash
myclaw slack connect
```

## Memory Settings (Beginner Language)

- Memory: remember durable facts, preferences, decisions, corrections, constraints, and procedures.
- Continuity: use remembered context so the agent can resume current work instead of starting cold.
- Storage backend: SQLite (`storage.provider=sqlite`). Postgres is not exposed until runtime persistence is provider-backed end to end.
- SQLite path: default local database at `store/myclaw.db`.
- Embeddings: optional OpenAI-powered ranking improvement for memory search.
- Dreaming: background memory cleanup and improvement.

Default choices:

- memory: on
- embeddings: off
- dreaming: on

Canonical memory block written by setup:

```yaml
storage:
  provider: sqlite
  sqlite:
    path: store/myclaw.db

memory:
  enabled: true
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: true
```

Memory and continuity work without embeddings. Enable embeddings only when you want better semantic ranking and are comfortable providing an OpenAI API key.

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
