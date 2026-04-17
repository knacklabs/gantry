---
name: myclaw-admin
description: |
  MyClaw self-administration reference for host runtime operations:
  status/doctor/setup, memory settings, group management, and service control.
user_invocable: false
---

# MyClaw Administration Reference

Runtime home defaults to `~/myclaw`. Host runtime is the only supported runtime mode.

## Core CLI

- `myclaw setup`
- `myclaw doctor`
- `myclaw status`
- `myclaw start`
- `myclaw restart`

## Memory CLI

- `myclaw memory status`
- `myclaw memory provider <sqlite|qmd|noop|none>`
- `myclaw memory embeddings <off|openai>`
- `myclaw memory dreaming <on|off>`

## Group CLI

- `myclaw agent list`
- `myclaw agent info <jid|folder>`
- `myclaw agent add <jid|chat-id>`
- `myclaw agent remove <jid|folder>`
- `myclaw agent trigger <jid|folder> <word>`

## Channel CLI

- `myclaw telegram connect`
- `myclaw slack connect`

## Service CLI

- `myclaw service install`
- `myclaw service start`
- `myclaw service stop`
- `myclaw service restart`

## Settings Source Of Truth

`~/myclaw/settings.yaml` controls runtime behavior for channels and memory.

Canonical memory block:

```yaml
memory:
  enabled: true
  provider: sqlite
  sqlite_path: store/memory.db
  qmd_root: agent-memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
```

`.env` is used for secrets and credentials (`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OPENAI_API_KEY`).

## Direct Edit Workflow

1. Edit `~/myclaw/settings.yaml`.
2. Run `myclaw doctor`.
3. Restart (`myclaw restart` or `myclaw service restart`).
4. Confirm with `myclaw status`.
