# MyClaw

Personal AI assistant runtime. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK via host runtime processes. Each group has isolated filesystem and memory boundaries.

## Key Files

| File | Purpose |
|------|---------|
| `apps/core/src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `apps/core/src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `apps/core/src/runtime/ipc.ts` | IPC watcher and task processing |
| `apps/core/src/messaging/router.ts` | Message formatting and outbound routing |
| `apps/core/src/core/config.ts` | Trigger pattern, paths, intervals |
| `apps/core/src/runtime/task-scheduler.ts` | Runs scheduled tasks |
| `apps/core/src/storage/db.ts` | SQLite operations |
| `~/myclaw/agents/{name}/CLAUDE.md` | Runtime per-agent memory files |
| `$AGENT_ROOT/.claude/skills/` | Custom skills (single source of truth, managed externally) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway and runtime environment controls. Run `onecli --help`.

## Skills

Four types of skills exist in MyClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Custom skills** — managed under `$AGENT_ROOT/.claude/skills/` (single source of truth, defaults to `~/myclaw/.claude/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/commands` | List all available slash commands with descriptions |
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Runtime issues, logs, troubleshooting |
| `/update-myclaw` | Bring upstream MyClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm run build        # Compile the app and agent runner
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.myclaw.plist
launchctl unload ~/Library/LaunchAgents/com.myclaw.plist
launchctl kickstart -k gui/$(id -u)/com.myclaw  # restart

# Linux (systemd)
systemctl --user start myclaw
systemctl --user stop myclaw
systemctl --user restart myclaw
```

## Troubleshooting

**Channel skill missing after upgrade:** Channels ship as skills, not built-in core modules. Install the relevant skill and then rebuild with `npm run build`.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.

## Agent Runner Build Cache

If you add or update the agent runner, rebuild from the repo root with `npm run build` so both the app and `packages/agent-runner` stay in sync.
