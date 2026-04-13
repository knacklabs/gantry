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

## Runtime Home

MyClaw stores mutable state under `AGENT_ROOT`.

Default path:

```text
~/myclaw
```

Contains:

- `.env`
- `store/`
- `groups/`
- `data/`
- `logs/`
- `.onboarding-state.json`

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

### Runtime home is not writable

Next action:

1. choose a different runtime home
2. or fix permissions on the selected folder

### Container runtime warning

MyClaw can still run in host mode. Install Docker (or Apple Container on macOS) later and rerun `myclaw doctor`.
