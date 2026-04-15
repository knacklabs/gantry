---
name: myclaw-admin
description: |
  MyClaw self-administration reference — CLI commands, settings.yaml schema, agent management,
  config operations, and service control. Use when asked to manage MyClaw itself: add/remove agents,
  change settings, edit config, restart service, check diagnostics, or troubleshoot runtime issues.
user_invocable: false
---

# MyClaw Administration Reference

Complete reference for managing the MyClaw runtime. The CLI binary is `myclaw` and runs on the host machine. The runtime home defaults to `~/myclaw`.

---

## CLI Commands

### Service Lifecycle

| Command | Description |
|---------|-------------|
| `myclaw start` | Start the runtime (validates settings.yaml first) |
| `myclaw restart` | Restart the runtime |
| `myclaw status` | Show runtime health and configuration |
| `myclaw doctor` | System diagnostics and dependency check |
| `myclaw setup` | Guided setup wizard (interactive) |

### Service Management (launchd/systemd)

| Command | Description |
|---------|-------------|
| `myclaw service install` | Install as system service |
| `myclaw service start` | Start background service |
| `myclaw service stop` | Stop background service |
| `myclaw service restart` | Restart background service |

**MCP equivalent:** `mcp__myclaw__service_restart` restarts the service from within an agent.

### Agent (Group) Management

| Command | Description |
|---------|-------------|
| `myclaw agent list` | List all registered agents |
| `myclaw agent info <jid\|folder>` | Show agent details |
| `myclaw agent add <jid\|chat-id>` | Register a new agent |
| `myclaw agent remove <jid\|folder>` | Unregister an agent |
| `myclaw agent trigger <jid\|folder> <word>` | Set trigger word |
| `myclaw agent trigger <jid\|folder> --off` | Disable trigger requirement |
| `myclaw agent policy <jid\|folder> ...` | Set sender allowlist policy |
| `myclaw agent policy-default ...` | Set default channel policy |
| `myclaw agent policy-show` | Display current policies |

**`agent add` options:**
- `--name <name>` — Display name
- `--folder <folder>` — Folder name (auto-generated if omitted)
- `--trigger <word>` — Trigger word for the agent
- `--main` — Mark as main agent
- `--requires-trigger true|false` — Whether trigger word is required
- `--test-message` / `--no-test-message` — Send test message after registration

**`agent policy` options:**
- `--allow "*"` — Allow all senders
- `--allow id1,id2` — Allow specific sender IDs
- `--mode trigger` — Require @mention for non-allowed senders
- `--mode drop` — Silently reject non-allowed senders
- `--clear` — Revert to default policy

**`agent policy-default` options:**
- `--channel telegram|slack` — Target channel
- `--allow` and `--mode` — Same as agent policy

**MCP equivalent:** `mcp__myclaw__register_agent` registers an agent from within the runtime.

### Configuration (.env)

| Command | Description |
|---------|-------------|
| `myclaw config list` | List all config keys (values masked for secrets) |
| `myclaw config get <KEY>` | Get a config value (masked) |
| `myclaw config get <KEY> --raw` | Get a config value (unmasked) |
| `myclaw config set <KEY> <VALUE>` | Set a config value |
| `myclaw config unset <KEY>` | Remove a config key |

**Key environment variables:**
- `TELEGRAM_BOT_TOKEN` — Telegram bot token
- `SLACK_BOT_TOKEN` — Slack bot token (xoxb-...)
- `SLACK_APP_TOKEN` — Slack app token (xapp-...)
- `MEMORY_PROVIDER` — `sqlite` (default) or `noop`
- `MEMORY_EMBED_PROVIDER` — `openai` or `disabled`
- `MEMORY_DREAMING_ENABLED` — `true` / `false`
- `MINI_APP_API_URL` — Tunnel URL for Mini App
- `MINI_APP_PORT` — Mini App port (default: 3100)
- `ASSISTANT_NAME` — Assistant display name
- `AGENT_ROOT` — Runtime home directory
- `AGENT_RUNTIME` — `container` (default) or `host`

### Channel Connection

| Command | Description |
|---------|-------------|
| `myclaw telegram connect` | Connect Telegram (setup wizard) |
| `myclaw slack connect` | Connect Slack (setup wizard) |

### Tunnel

| Command | Description |
|---------|-------------|
| `myclaw tunnel quick` | Start Cloudflare quick tunnel, auto-update MINI_APP_API_URL |

### Global Options

- `--runtime-home <path>` — Override runtime home (default: ~/myclaw)
- `-h, --help` — Show help

---

## settings.yaml

**Location:** `~/myclaw/settings.yaml`

This file controls channel enable/disable, sender policies, and feature flags. Validated on `start`/`restart`.

### Full Schema

```yaml
channels:
  telegram:
    enabled: true                          # boolean — enable/disable Telegram
  slack:
    enabled: false                         # boolean — enable/disable Slack

features:
  memory: true                             # file-based + SQLite structured memory
  embeddings: false                        # semantic vector search (requires MEMORY_EMBED_PROVIDER=openai)
  dreaming: true                           # scheduled memory consolidation jobs

message_policy:
  sender_allowlist:
    default:
      allow: "*"                           # "*" or ["id1", "id2"] — allowed sender IDs
      mode: "trigger"                      # "trigger" (require @mention) or "drop" (reject silently)
    chats:
      <chat_jid>:                          # per-chat override, e.g. tg_-1003687469956
        allow: ["5759865942"]
        mode: "trigger"
    log_denied: true                       # log denied messages for debugging
```

### Validation Rules

- At least one channel must be enabled
- Enabled channels must have matching tokens in .env (TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN + SLACK_APP_TOKEN)
- At least one registered agent must exist for each enabled channel
- `allow` must be `"*"` or an array of string IDs
- `mode` must be `"trigger"` or `"drop"`

### Editing settings.yaml

To modify settings.yaml from within the agent runtime:
1. Read the current file: `~/myclaw/settings.yaml`
2. Edit the specific section needed
3. Restart the service: `mcp__myclaw__service_restart`

Changes take effect after restart.

---

## Runtime File Layout

```
~/myclaw/
  settings.yaml              # Service config (this reference)
  .env                       # Secrets and env vars
  service-meta.json          # Runtime entry point
  scheduler-jobs.json        # Scheduled job definitions
  CLAUDE.md                  # Master agent profile
  agent-memory/              # Global durable memory
    procedures/              # Reusable workflows
    profile/                 # User facts
    knowledge/               # Knowledge base
  agents/
    shared/CLAUDE.md         # Shared profile for all agents
    <channel>_<name>/        # Per-agent folder
      CLAUDE.md              # Agent-specific profile
      memory/                # Local memory files
      conversations/         # Conversation history
      logs/                  # Execution logs
  store/
    memory.db                # Embeddings database
    messages.db              # Message history
  data/
    browser-profiles/        # Headless browser state
    plans/                   # Plan snapshots
  .claude/
    skills/                  # Skill definitions
    settings.json            # Claude Code harness config
```

---

## MCP Tools for Self-Management

These MCP tools are available from within agent sessions:

| Tool | Purpose |
|------|---------|
| `mcp__myclaw__service_restart` | Restart the MyClaw service |
| `mcp__myclaw__register_agent` | Register a new agent/group |
| `mcp__myclaw__scheduler_upsert_job` | Create or update a scheduled job |
| `mcp__myclaw__scheduler_get_job` | Get job details |
| `mcp__myclaw__scheduler_list_jobs` | List all jobs |
| `mcp__myclaw__scheduler_delete_job` | Delete a job |
| `mcp__myclaw__scheduler_pause_job` | Pause a job |
| `mcp__myclaw__scheduler_resume_job` | Resume a paused job |
| `mcp__myclaw__scheduler_trigger_job` | Trigger a job immediately |
| `mcp__myclaw__scheduler_list_runs` | List recent job runs |
| `mcp__myclaw__scheduler_get_dead_letter` | Get failed job details |
| `mcp__myclaw__scheduler_update_job` | Update job properties |
| `mcp__myclaw__memory_save` | Save a memory entry |
| `mcp__myclaw__memory_search` | Search memory |
| `mcp__myclaw__memory_patch` | Update a memory entry |
| `mcp__myclaw__procedure_save` | Save a procedure |
| `mcp__myclaw__procedure_patch` | Update a procedure |
| `mcp__myclaw__send_message` | Send a message to a chat |
| `mcp__myclaw__ask_user_question` | Ask user with interactive buttons |
| `mcp__myclaw__create_plan` | Create a plan |
| `mcp__myclaw__get_plan` | Get current plan |
| `mcp__myclaw__update_plan_section` | Update plan section |
| `mcp__myclaw__browser_launch` | Launch headless browser |
| `mcp__myclaw__browser_close` | Close browser |
| `mcp__myclaw__browser_status` | Check browser status |
| `mcp__myclaw__browser_profile_list` | List browser profiles |

---

## Common Admin Workflows

### Add a new Telegram agent
```bash
# On host
myclaw agent add <chat-id> --name "Team Chat" --trigger kai
myclaw restart
```

### Change sender policy
Edit `settings.yaml` under `message_policy.sender_allowlist.chats`:
```yaml
message_policy:
  sender_allowlist:
    chats:
      tg_-1003687469956:
        allow: ["5759865942", "123456789"]
        mode: trigger
```
Then restart.

### Enable Slack
```bash
# On host
myclaw slack connect
# Follow the setup wizard, then:
myclaw restart
```

### Toggle a feature flag
Edit `~/myclaw/settings.yaml`, change the feature value, then restart:
```bash
# From within agent — edit the file then:
mcp__myclaw__service_restart
```

### Check why messages are being dropped
1. Check `settings.yaml` — is `log_denied: true` set?
2. Check sender allowlist — is the sender ID in the allow list?
3. Check mode — `trigger` requires @mention, `drop` silently rejects
4. Check logs in `~/myclaw/agents/<folder>/logs/`

### Restart after config change
From within agent session:
```
mcp__myclaw__service_restart
```
From host:
```bash
myclaw restart
# or
myclaw service restart
```
