---
name: commands
description: List available MyClaw chat commands and installed skill packs. Use when the user types /commands, asks "what commands are available", or wants to see available skills.
user_invocable: true
---

# /commands

List available commands grouped by category with a one-line description for each.

## Steps

1. Print the MyClaw host-managed session commands.
2. Print bundled MyClaw skills available in the package/runtime.
3. Print approved and enabled skill bindings when the control API exposes them.
4. Format output for the active channel.

## MyClaw Session Commands

These are handled by the MyClaw host runtime, not by skill files:

- `/compact` -- Ask the Claude Agent SDK to compact context, then collect durable MyClaw memory at the compact boundary
- `/new` -- Reset the current group session state while preserving durable memory
- `/model` -- Show the current model selection
- `/model <value>` -- Set the group model override after validation
- `/model default` -- Clear the group model override

## Bundled MyClaw Skills

- `/commands` -- List available commands and installed skill packs
- `myclaw-admin` -- Runtime administration reference (non-user-invocable)

## Runtime Browser Capability

- `Browser` -- Canonical browser capability selected per agent
- `myclaw-browser` -- Runtime-installed browser gateway guidance

MyClaw launches the persistent browser profile headed by default. Durable
authority is the canonical `Browser` capability; runtime projects it to
MyClaw-owned browser gateway tools. Users do not install or edit browser skills
manually.

## Semantic Tool Capabilities

- `capability_search` -- Find built-in semantic capabilities such as `google.sheets.write`
- `request_capability` -- Request a reviewed semantic capability for durable reuse
- `propose_local_cli_capability` -- Propose an authenticated local CLI capability with pinned executable, templates, preflight, and protected paths
- `manage_capability` -- View, revoke, change, test, or inspect audit history for approved capabilities

Use semantic capability tools before asking for raw scoped Bash fallback for
app workflows such as Google Sheets, Gmail, or business CLIs. Durable exact
low-level tool grants are limited to canonical `Browser` and selected
first-party MyClaw admin tools; broad SDK/native tools and exact third-party
MCP tools are not persistent authority.

## Built-In Memory Behavior

Memory and continuity are automatic runtime behavior, not slash commands in this release:

- Memory stores durable facts, preferences, decisions, corrections, constraints, and procedures.
- Continuity uses injected memory context so the agent can resume current work and prior decisions.
- Embeddings are optional. Memory still saves, searches, and injects context when embeddings are disabled.
- Ask the agent to remember a durable fact only when it should be useful later. Do not ask it to save raw logs or temporary task progress as memory.

## MyClaw CLI Commands

These run on the host machine:

- `myclaw setup` -- Guided setup wizard
- `myclaw doctor` -- Runtime diagnostics and dependency checks
- `myclaw status` -- Show runtime health and configuration
- `myclaw memory status` -- Show memory/storage/embeddings/dreaming state
- `myclaw memory embeddings <off|openai>` -- Set embeddings mode
- `myclaw memory dreaming <on|off>` -- Set dreaming mode
- `myclaw start` -- Start MyClaw in the foreground
- `myclaw restart` -- Restart the installed service when available
- `myclaw telegram connect` -- Connect or reconnect Telegram
- `myclaw slack connect` -- Connect or reconnect Slack
- `myclaw service install` -- Install the background service
- `myclaw service start` -- Start the background service
- `myclaw service stop` -- Stop the background service
- `myclaw agent list` -- List registered agents/groups
- `myclaw agent add <jid|chat-id>` -- Register a new agent/group
- `myclaw skill draft upload <skill.zip>` -- Upload a skill zip as a draft
- `myclaw config list` -- List runtime config keys with secrets masked

## gstack (If Installed)

Development and review:

- `/review` -- Pre-landing PR review for structural issues
- `/ship` -- Ship workflow: tests, review, changelog, PR
- `/land-and-deploy` -- Merge PR, wait for CI, verify production
- `/document-release` -- Update docs to match what shipped
- `/retro` -- Weekly engineering retrospective with trends
- `/codex` -- OpenAI Codex: code review, challenge, consult modes
- `/autoplan` -- Auto-review pipeline
- `/simplify` -- Review changed code for reuse and quality

Planning and strategy:

- `/plan-ceo-review` -- CEO/founder-mode plan review
- `/plan-eng-review` -- Engineering architecture and test plan review
- `/plan-design-review` -- Designer's-eye plan review
- `/office-hours` -- YC-style forcing questions or brainstorming

Design and QA:

- `/design-consultation` -- Full design system proposal
- `/design-review` -- Visual QA and polish
- `/qa` -- QA test an app and fix bugs found
- `/qa-only` -- QA report only, no fixes

Safety and security:

- `/cso` -- Security audit
- `/careful` -- Warn before destructive commands
- `/freeze` -- Lock edits to a directory
- `/guard` -- Combined careful and freeze
- `/unfreeze` -- Remove freeze boundary
- `/investigate` -- Root-cause debugging workflow

Utility:

- `/gstack-upgrade` -- Upgrade gstack
- `/learn` -- Learn new patterns
- `/setup-deploy` -- Configure deployment settings

## Claude Code Built-In Commands

- `/update-config` -- Configure Claude Code settings/hooks
- `/keybindings-help` -- Customize keyboard shortcuts
- `/loop` -- Run a command on a recurring interval
- `/schedule` -- Create/manage scheduled remote agents
- `/claude-api` -- Build Anthropic SDK apps
