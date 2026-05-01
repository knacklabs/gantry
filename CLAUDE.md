# MyClaw

Personal AI assistant runtime. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with a provider-neutral and channel-neutral capability
system. Built-in providers (Telegram, Slack, Teams, and Web/API targets) are
registered as adapters around canonical app, agent, conversation, thread,
message, and session concepts. Messages route to the Claude Agent SDK via host
runtime processes. Agent-visible capabilities are approved, audited, bound to
an agent, and activated on the next run.

## Key Files

| File                                             | Purpose                                                    |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `apps/core/src/index.ts`                         | Orchestrator: state, message loop, agent invocation        |
| `apps/core/src/channels/provider-registry.ts`    | Channel provider registry                                  |
| `apps/core/src/runtime/ipc.ts`                   | IPC watcher and task processing                            |
| `apps/core/src/messaging/router.ts`              | Message formatting and outbound routing                    |
| `apps/core/src/config/index.ts`                   | Trigger pattern, paths, intervals                          |
| `apps/core/src/jobs/scheduler.ts`        | Scheduler domain execution                                 |
| `apps/core/src/infrastructure/pgboss/scheduler-engine.ts` | Postgres-backed pg-boss queue adapter                      |
| `apps/core/src/infrastructure/postgres/schema/`                | Postgres schema, migrations, and repositories              |
| `~/myclaw/agents/{name}/CLAUDE.md`               | Runtime per-agent prompt guidance                          |
| Provider artifact store                          | Claude provider continuation and transcript export bytes   |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway and runtime environment controls. Run `onecli --help`.

## Capability Rules

Do not install or mutate capabilities directly. Agents must not run dependency
install commands, edit `.claude/skills`, edit `.mcp.json`, edit settings, or
change Claude permission config. Use MyClaw request tools so changes can be
reviewed, audited, versioned, and activated on the next run.

| Tool | When to use |
| --- | --- |
| `send_message` | Progress updates or direct channel messages while still running. |
| `ask_user_question` | Structured choices with options, single-select, multi-select, preview/details, and channel-native buttons. |
| `request_skill_install` | Install a provider skill such as `clawhub:<slug>@<version>`. |
| `request_skill_proposal` | Propose an agent-created or modified skill bundle for review. |
| `request_skill_dependency_install` | Ask for npm, brew, go, uv, or download dependencies needed by a skill. |
| `request_mcp_server` | Request a third-party MCP server with transport, origin, tool patterns, credentials, and reason. |
| `request_tool_enable` | Request SDK or host tools such as `Bash`, `Write`, `Edit`, browser, scheduler, memory, or service tools. |
| `request_channel_tool_enable` | Request channel capabilities such as Teams proactive messaging, Slack file access, or Telegram file download behavior. |
| `service_restart` | Main/admin agent only, after an approved change requires host restart. |
| `register_agent` | Main/admin agent only, to bind a new channel conversation to an agent. |

Same-channel approval verifies the origin chat and control allowlist; it does
not let a normal participant approve persistent capability changes.

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
```

Service management:

```bash
myclaw service install
myclaw service start
myclaw service stop
myclaw service restart
myclaw status
```

## Troubleshooting

**Channel unavailable after upgrade:** Built-in channels are registered by the core runtime. Rebuild with `npm run build`, then run `myclaw doctor` to verify channel settings and credentials.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.

## Agent Runner Build Cache

If you add or update the agent runner, rebuild from the repo root with `npm run build` so `apps/core/src/runner` and emitted dist artifacts stay in sync.
