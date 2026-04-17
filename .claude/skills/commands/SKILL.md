---
name: commands
description: List all available slash commands grouped by category. Use when the user types /commands, asks "what commands are available", or wants to see available skills.
user_invocable: true
---

# /commands

List all available slash commands grouped by category with a one-line description for each.

## Steps

1. Check which optional skill packs are installed by looking for their directories under `~/.claude/skills/`.
2. Print the MyClaw built-in commands (always available).
3. For each installed skill pack (e.g., gstack), print its commands grouped by category.
4. Print the Claude Code built-in commands (always available).
5. Format output for the current channel (check the group folder name prefix for Telegram, Slack, WhatsApp, Discord formatting rules).

## MyClaw Built-in

- `/commands` -- List all available commands (this skill)
- `/setup` -- First-time installation, authentication, service configuration
- `/customize` -- Adding channels, integrations, changing behavior
- `/debug` -- Container issues, logs, troubleshooting
- `/update-myclaw` -- Bring upstream MyClaw updates into a customized install
- `/init-onecli` -- Install OneCLI Agent Vault and migrate .env credentials

## gstack (if ~/.claude/skills/gstack exists)

Development & Review:
- `/review` -- Pre-landing PR review for structural issues
- `/ship` -- Ship workflow: tests, review, changelog, PR
- `/land-and-deploy` -- Merge PR, wait for CI, verify production
- `/document-release` -- Update docs to match what shipped
- `/retro` -- Weekly engineering retrospective with trends
- `/codex` -- OpenAI Codex: code review, challenge, consult modes
- `/autoplan` -- Auto-review pipeline (CEO + design + eng)
- `/simplify` -- Review changed code for reuse and quality

Planning & Strategy:
- `/plan-ceo-review` -- CEO/founder-mode: challenge premises, dream big
- `/plan-eng-review` -- Eng manager-mode: architecture, edge cases, tests
- `/plan-design-review` -- Designer's eye on the plan, rate 0-10
- `/plan-devex-review` -- Developer experience review
- `/office-hours` -- YC-style forcing questions or brainstorming

Design & QA:
- `/design-consultation` -- Full design system proposal
- `/design-review` -- Visual QA: spacing, hierarchy, AI slop detection
- `/design-shotgun` -- Rapid design iteration
- `/design-html` -- Design as HTML prototypes
- `/qa` -- QA test a web app and fix bugs found
- `/qa-only` -- QA report only, no fixes
- `/devex-review` -- Developer experience audit

Browsing & Monitoring:
- `/browse` -- Headless browser for QA and site testing
- `/connect-chrome` -- Connect to running Chrome instance
- `/setup-browser-cookies` -- Import cookies from your real browser
- `/benchmark` -- Performance regression detection
- `/canary` -- Post-deploy canary monitoring

Safety & Security:
- `/cso` -- Chief Security Officer audit
- `/careful` -- Warn before destructive commands
- `/freeze` -- Lock edits to a specific directory
- `/guard` -- Combined careful + freeze
- `/unfreeze` -- Remove freeze boundary
- `/investigate` -- Systematic debugging with root cause analysis

Utility:
- `/gstack-upgrade` -- Upgrade gstack to latest
- `/learn` -- Learn new patterns
- `/setup-deploy` -- Configure deploy settings

## Claude Code Built-in

- `/update-config` -- Configure Claude Code settings/hooks
- `/keybindings-help` -- Customize keyboard shortcuts
- `/loop` -- Run a command on a recurring interval
- `/schedule` -- Create/manage scheduled remote agents
- `/claude-api` -- Build Anthropic SDK apps
