# VM Runtime Configuration

This is the quick deployment contract for shipping MyClaw to a fresh VM.

Use two files only:

- `~/myclaw/settings.yaml` for behavior, channels, and declared host capabilities
- `~/myclaw/.env` for secrets, tokens, and machine-specific endpoints

## Keep In `settings.yaml`

Put stable runtime behavior here:

- which channels are enabled
- sender allowlists
- feature flags like memory / embeddings / dreaming
- which host capabilities should exist on this machine

Example:

```yaml
channels:
  telegram:
    enabled: false
    sender_allowlist:
      default:
        allow: '*'
        mode: trigger
      agents: {}
      log_denied: true
  slack:
    enabled: true
    sender_allowlist:
      default:
        allow: '*'
        mode: trigger
      agents: {}
      log_denied: true
features:
  memory: true
  embeddings: false
  dreaming: false
host_capabilities:
  google_workspace:
    mode: on
    command: gws
    use_onecli: true
  fast_lookup:
    enabled: true
```

Google Workspace capability fields:

- `mode: off` disables Google CLI guidance entirely
- `mode: auto` keeps the old detect-if-present behavior
- `mode: on` means this VM is expected to have Google Workspace CLI available
- `command` chooses `gws`, `gworkspace`, or `auto`
- `use_onecli: true` means agents should prefer `onecli exec -- gws ...`

Fast lookup capability fields:

- `enabled: true` exposes the fast lookup tool to agents
- `enabled: false` removes that tool from agent runtime on the VM

## Keep In `.env`

Put secrets and machine-local wiring here:

- channel secrets
- model/provider auth
- OneCLI gateway URL
- optional overrides for certificate paths or host CLI internals

Example:

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
CLAUDE_CODE_OAUTH_TOKEN=...
MYCLAW_CREDENTIAL_MODE=onecli-only
ONECLI_URL=http://127.0.0.1:10254
MYCLAW_IPC_AUTH_SECRET=replace-me
```

Optional advanced overrides:

```dotenv
SSL_CERT_FILE=/etc/ssl/cert.pem
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file
OPENAI_API_KEY=...
```

Notes:

- `SSL_CERT_FILE` and `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file` are auto-injected for `gws` when possible, so you usually do not need to set them yourself.
- Do not put Google OAuth client secrets or Gmail tokens in `settings.yaml`.
- Do not put sender policy or feature flags in `.env`.

## VM Bring-Up Flow

1. Install Node and MyClaw.
2. Install required host CLIs such as `onecli` and `gws`.
3. Copy `settings.yaml`.
4. Copy `.env`.
5. Run `myclaw doctor`.
6. Run `myclaw service install` and `myclaw service start`.

## Why This Split

- `settings.yaml` is safe to template, diff, and commit as an ops example
- `.env` stays machine-specific and secret-bearing
- `myclaw doctor` can now validate the declared host-capability intent against what the VM actually has installed
