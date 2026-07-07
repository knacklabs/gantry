# Compact Human Settings.yaml

## Summary

`~/gantry/settings.yaml` should be the local user's editable desired-state file,
not a dump of runtime projection details. The compact settings work should make
the file understandable to a non-technical admin by rendering only values the
user can reasonably change and by hiding defaults, internal IDs, timestamps, and
artifact hashes.

`gantry settings validate` is the strict schema check for manual edits. It
parses the same compact and verbose settings shapes used by runtime startup and
admin update flows, rejects unsupported keys and duplicate YAML keys, and does
not require Postgres, provider credentials, or runtime preflight checks.

The current file is confusing because it mixes `agent` and `agents`, separates
`conversations` from `conversation_installs`, exposes empty defaults, and uses opaque skill
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
    bot_token_ref: gantry-secret:TELEGRAM_BOT_TOKEN

agents:
  main_agent:
    name: 'Default Agent'

  kai:
    name: Kai
    skills:
      - gantry-admin
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

Conversation entries may render `brain_harvest: true` when an admin opts that
conversation into company brain channel harvest. The default is off and should
not render as `false`; the opt-in itself is the user/admin disclosure decision.

`permissions.yolo_mode` is rendered only when the user changes it from shipped
defaults. `denylist` and `denylist_paths` are user additions; the effective
runtime policy always merges them with the shipped command and path defaults
unless `enabled: false`.

## Settings Ownership

`settings.yaml` is desired state, not runtime history. It has three ownership
lanes:

- User/admin editable configuration: values a local operator may edit, validate,
  and apply through setup, CLI, Control API admin routes, or reviewed settings
  tools.
- Agent-requested reviewed changes: values an agent can ask to change, but only
  Gantry writes them after the user/admin approval flow succeeds.
- Runtime-owned state: data that must stay out of `settings.yaml` and live in
  Postgres, Credential Center, runtime secrets, logs, or artifact stores.

Supported settings roots:

| Root                   | Ownership lane                          | Notes                                                                                                                                        |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaults`             | User/admin editable                     | Compact defaults for display name, chat model, and job model defaults.                                                                       |
| `agent`                | User/admin editable, verbose form       | Verbose global agent defaults after compact normalization.                                                                                   |
| `agents`               | Mixed                                   | Identity/model/persona fields are user/admin editable; `sources` and `capabilities` may also be written by approved source/capability flows. |
| `providers`            | User/admin editable                     | Provider enablement metadata.                                                                                                                |
| `provider_accounts`    | User/admin editable, advanced form      | Explicit Provider Account records with agent ownership and runtime-secret refs.                                                              |
| `conversations`        | User/admin editable                     | External conversation id, kind, display name, approvers, sender policy, installed agents, and optional model override.                       |
| `conversation_installs` | User/admin editable, advanced form      | Explicit Conversation Install records when compact conversation ownership is not enough.                                                     |
| `memory`               | User/admin editable                     | Memory, embeddings, dreaming, LLM model aliases, and maintenance knobs.                                                                      |
| `permissions`          | User/admin editable                     | YOLO-mode additions and egress denylist.                                                                                                     |
| `browser`              | User/admin editable                     | Browser usage policy and per-site limits.                                                                                                    |
| `runtime`              | User/admin editable, operational tuning | Runtime queue concurrency and retry policy. Restart after changing queue values.                                                             |
| `storage`              | User/admin editable, advanced form      | Postgres URL env key and schema only; the URL itself is not stored here.                                                                     |
| `model_access`         | User/admin editable, advanced form      | Gantry model gateway enablement and loopback bind host only.                                                                                 |
| `desired_state`        | Admin/export flow                       | Desired-state reconciliation switch.                                                                                                         |

`agents.<id>.access.sources` is inventory. Installing a skill, connecting an MCP
server, attaching a built-in, adapter, or local CLI may update this list after
review, but it never grants authority by itself.

`agents.<id>.access.selections` is durable authority. Agents may request reviewed
capability ids with `request_access target.kind=capability`; Gantry writes the
selected capability only after the approval flow succeeds.
`request_access target.kind=run_command` remains the exact scoped command
fallback, not the normal path for durable semantic authority.

Optional queue tuning:

```yaml
runtime:
  queue:
    max_message_runs: 3
    max_job_runs: 4
    max_retries: 5
    base_retry_ms: 5000
```

Runtime-owned state must not be mirrored into settings: message transcripts,
job runs, run events, audit events, memory records, generated runtime
directories, artifact hashes, Postgres projection rows, raw provider secrets,
model credentials, and capability secret values.

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
  - `conversations.<conversation>.model` overrides only that install when
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

Settings should make selected skills readable without making display labels
authoritative. Skill source rows render the catalog name beside the exact
catalog id:

```yaml
agents:
  kai:
    sources:
      skills:
        - name: company-handbook
          id: 'skill:266c421f-a072-44f7-9cb0-43c52eba8ad9'
```

The skill catalog keeps internal IDs, storage pointers, and audit history. The
`name` field is a display hint exported from the catalog; editing or deleting
it must not change what runs. The `id` field is the source of truth for
selection, validation, runtime materialization, and duplicate-name
disambiguation. CLI/API/admin-tool output should show `name (skill:<id>)` when
space allows, while artifact refs remain debug detail.

## Surface Impact Matrix

| Surface                     | Classification       | Plan                                                                                             |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| Runtime behavior            | Changed              | Parse compact settings, expand inherited defaults, and reconcile to existing runtime projection. |
| `settings.yaml`             | Changed              | Render compact human desired state only.                                                         |
| Postgres/runtime projection | Changed              | Keep normalized tables; add skill alias resolution before writing capability bindings.           |
| Control API                 | Changed              | Diagnostic settings reads return compact public shape and effective-source metadata.             |
| SDK/contracts               | Changed              | Add compact settings and skill alias shapes where public.                                        |
| CLI                         | Changed              | `settings export` writes compact YAML; clear commands delete overrides.                          |
| Gantry MCP/admin skill      | Changed              | Settings patch tools use compact fields and skill aliases.                                       |
| Channel/provider adapters   | Unchanged by design  | Runtime adapter behavior stays the same.                                                         |
| Docs/prompts                | Changed              | Add settings guide with inherited setting examples and reset behavior.                           |
| Audit/events                | Read-only/observable | Skill artifact history remains in DB/artifact stores.                                            |
| Tests/verification          | Changed              | Add parse/render/reconcile and effective-source tests.                                           |

## Implementation Notes

- This is the current settings shape, not a versioned compatibility path.
  Gantry is still early-stage, so the implementation should make one clean cut
  to the compact format.
- Collapse singular `agent` into `defaults` and actual agents under `agents`.
- Collapse common one-agent installs into `conversations.<id>.installed_agents`.
- Preserve an advanced form for multiple Provider Accounts or multiple
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
  the same conversations, approvers, installs, and capabilities.
- CLI: list effective settings with source labels and clear overrides by
  deleting keys.
- Doctor: report effective values, inherited source, stale v1 settings, unknown
  aliases, and missing skill artifacts.

## Assumptions

- This is a single clean cut because Gantry is still early-stage.
- Runtime/audit/history data stays out of `settings.yaml`.
- Skill aliases are the user-facing contract; IDs and artifact refs are
  internal.
- Defaults should be invisible unless the user changes them.
