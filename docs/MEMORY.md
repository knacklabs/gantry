# Memory System

MyClaw memory stores durable facts, decisions, preferences, corrections, constraints, and reusable procedures.

Continuity uses remembered context to help the next run continue work without replaying full chat history.

## Runtime Truth

- Host runtime only.
- `settings.yaml` is the canonical runtime behavior config.
- `.env` is for secrets and channel credentials.

## Canonical Settings

Memory behavior is configured only in `~/myclaw/settings.yaml`:

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

## Providers

### `sqlite`

- SQLite-only storage.
- Uses `memory.sqlite_path`.
- No markdown mirror.

### `qmd`

- SQLite + markdown mirror.
- Uses `memory.qmd_root`.
- SQLite remains the search source of truth.

### `noop` / `none`

- Non-persistent mode.
- Useful for temporary testing only.

## Embeddings

- Optional.
- Disabled by default.
- Memory save/search/injection works when embeddings are disabled.
- `openai` requires `OPENAI_API_KEY` in `.env`.

## Dreaming

- Optional background memory refinement.
- Disabled by default.
- Should be used only with persistent memory providers.

## User Controls

- `myclaw status`
- `myclaw doctor`
- `myclaw memory status`
- `myclaw memory provider <sqlite|qmd|noop|none>`
- `myclaw memory embeddings <off|openai>`
- `myclaw memory dreaming <on|off>`

## Direct Editing Flow

1. Edit `~/myclaw/settings.yaml`.
2. Run `myclaw doctor`.
3. Restart (`myclaw restart` or `myclaw service restart`).
4. Confirm with `myclaw status`.
