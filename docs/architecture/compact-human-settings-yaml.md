# Compact Human Settings.yaml

## Summary

`~/myclaw/settings.yaml` should be the local user's editable desired-state file,
not a dump of runtime projection details. The compact settings work should make
the file understandable to a non-technical admin by rendering only values the
user can reasonably change and by hiding defaults, internal IDs, timestamps, and
artifact hashes.

The current file is confusing because it mixes `agent` and `agents`, separates
`conversations` from `bindings`, exposes empty defaults, and uses opaque skill
UUIDs that do not help users recognize or manage skills.

## Target Shape

Render compact settings around the concepts users understand:

```yaml
defaults:
  model: opus

providers:
  telegram:
    enabled: true
    label: 'Ravi Telegram Bot'
    bot_token_env: TELEGRAM_BOT_TOKEN

agents:
  main_agent:
    name: 'Default Agent'

  kai:
    name: Kai
    skills:
      - myclaw-admin
      - browser

conversations:
  main_dm:
    provider: telegram
    id: '5759865942'
    type: dm
    display_name: 'Main DM'
    approvers: ['5759865942']
    agent: main_agent
    trigger: '@Default Agent'

  kai:
    provider: telegram
    id: '-1003986348737'
    type: channel
    display_name: Kai
    approvers: ['5759865942']
    agent: kai
    trigger: '@Default Agent'

permissions:
  yolo_mode:
    enabled: true
    denylist:
      - npm run nuke
    denylist_paths:
      - /opt/danger/*
  egress:
    denylist:
      - '*.blocked.example.com'
```

Do not render disabled providers, empty arrays, empty inherited model defaults,
internal provider connection IDs, runtime storage internals, or credential
broker internals unless the user changed them from defaults. Binding timestamps
are advanced state; keep them out of common examples and only preserve them
where omitting the value would mutate live desired state.

`permissions.yolo_mode` is rendered only when the user changes it from shipped
defaults. `denylist` and `denylist_paths` are user additions; the effective
runtime policy always merges them with the shipped command and path defaults
unless `enabled: false`.

## Inherited Settings Documentation

The implementation must include user-facing documentation that explains how
inheritance works and how to override or reset inherited values. This should live
in a short settings guide linked from README and setup output.

Document these rules:

- Missing values inherit from `defaults`.
- Empty strings are not a user-facing reset mechanism in compact settings.
- To override a value, add the setting at the nearest owner:
  - `defaults.model` applies globally.
  - `agents.<agent>.model` overrides the default for that agent.
  - `agents.<agent>.jobs.one_time_model` and
    `agents.<agent>.jobs.recurring_model` override only job runs.
  - `conversations.<conversation>.model` overrides only that binding when
    supported.
- To reset a value back to inheritance, delete the override line.
- CLI commands that clear a setting must remove the compact setting from YAML,
  not write an empty string.
- Doctor should show effective values and their source, for example
  `kai model: opus (inherited from defaults.model)`.

The guide must include examples for common edits:

```yaml
# Change all agents unless they override it.
defaults:
  model: sonnet

# Change only one agent.
agents:
  kai:
    name: Kai
    model: haiku

# Reset Kai back to the global default by deleting model.
agents:
  kai:
    name: Kai
```

## Skill And Capability UX

Settings should reference skills by stable human aliases, not artifact IDs:

```yaml
agents:
  kai:
    skills:
      - company-handbook
      - github-review
```

The skill catalog keeps internal IDs, artifact hashes, versions, and audit
history. Settings uses aliases. Editing a skill creates a new approved version
under the same alias; old artifacts remain available for audit or rollback but
do not appear in normal settings.

Until every approved skill has a stable alias, compact rendering must hide raw
`skill:<uuid>` references instead of exposing them as editable YAML. Those
bindings remain in Postgres/runtime projection and should be managed through
CLI/API/admin-tool surfaces that can show names and versions safely.

CLI/API/admin-tool output should show display name, alias, latest approved
version, and enabled agents. Raw skill IDs and artifact refs belong only in
debug detail.

## Surface Impact Matrix

| Surface                     | Classification       | Plan                                                                                             |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| Runtime behavior            | Changed              | Parse compact settings, expand inherited defaults, and reconcile to existing runtime projection. |
| `settings.yaml`             | Changed              | Render compact human desired state only.                                                         |
| Postgres/runtime projection | Changed              | Keep normalized tables; add skill alias resolution before writing capability bindings.           |
| Control API                 | Changed              | Diagnostic settings reads return compact public shape and effective-source metadata.             |
| SDK/contracts               | Changed              | Add compact settings and skill alias shapes where public.                                        |
| CLI                         | Changed              | `settings export-current` writes compact YAML; clear commands delete overrides.                  |
| MyClaw MCP/admin skill      | Changed              | Settings patch tools use compact fields and skill aliases.                                       |
| Channel/provider adapters   | Unchanged by design  | Runtime adapter behavior stays the same.                                                         |
| Docs/prompts                | Changed              | Add settings guide with inherited setting examples and reset behavior.                           |
| Audit/events                | Read-only/observable | Skill version and artifact history remain in DB/artifact stores.                                 |
| Tests/verification          | Changed              | Add parse/render/reconcile and effective-source tests.                                           |

## Implementation Notes

- This is the current settings shape, not a versioned compatibility path.
  MyClaw is still early-stage, so the implementation should make one clean cut
  to the compact format.
- Collapse singular `agent` into `defaults` and actual agents under `agents`.
- Collapse common one-agent bindings into `conversations.<id>.agent`.
- Preserve an advanced form for multiple provider connections or multiple
  agents in one conversation, but render it only when needed.
- Treat deleted overrides as inherited values during reconcile.
- Keep raw secrets out of settings; env key references are still allowed.

## Test Plan

- Unit: compact parse/render round trip with omitted defaults.
- Unit: effective-source calculation for global, agent, job, and conversation
  overrides.
- Unit: clearing model/job overrides deletes YAML keys and restores inheritance.
- Unit: unknown skill aliases fail with suggestions.
- Integration: export current local state to compact settings and reconcile to
  the same conversations, approvers, bindings, and capabilities.
- CLI: list effective settings with source labels and clear overrides by
  deleting keys.
- Doctor: report effective values, inherited source, stale v1 settings, unknown
  aliases, and missing skill artifacts.

## Assumptions

- This is a single clean cut because MyClaw is still early-stage.
- Runtime/audit/history data stays out of `settings.yaml`.
- Skill aliases are the user-facing contract; IDs and artifact hashes are
  internal.
- Defaults should be invisible unless the user changes them.
