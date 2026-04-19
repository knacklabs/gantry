# Google Capabilities via Host CLI

## Recommended Path

For Google Sheets, Gmail, Calendar, and Forms, the easiest MyClaw integration path is:

```text
agent -> Bash tool -> onecli exec -- gws ... -> Google API
```

Do not start by adding Google SDK code to MyClaw core.
Do not start by writing a custom Sheets or Gmail MCP server.

MyClaw's current architecture is host-first:

- capabilities come from CLIs installed on the host
- credentials should stay in OneCLI
- agents invoke credentialed CLIs through `onecli exec -- ...`

## What To Install

Install these on the host where MyClaw runs:

- `onecli`
- `gws` (Google Workspace CLI; Homebrew package `googleworkspace-cli`)

Keep versions pinned in your provisioning scripts when possible.

## Credential Setup

Store Google credentials in OneCLI instead of:

- repo files
- `settings.yaml`
- agent instructions committed to source
- ad hoc `.env` keys for Google services

Declare runtime intent in `settings.yaml` instead:

```yaml
host_capabilities:
  google_workspace:
    mode: on
    command: gws
    use_onecli: true
```

The preferred pattern is:

```bash
onecli exec -- gws sheets spreadsheets get ...
onecli exec -- gws sheets spreadsheets values get ...
onecli exec -- gws gmail users messages list ...
onecli exec -- gws calendar events list ...
```

## Agent Guidance

When you give an agent Google access, document the capability in its local instructions:

- which CLI is available
- which accounts or scopes it may use
- which commands are read-only
- which commands require approval before execution

Recommended baseline rule:

```text
Always invoke credentialed host CLIs through `onecli exec -- <cli> ...`.
```

## Guardrails

Use these guardrails from day one:

1. Keep Google credentials in OneCLI only.
2. Start with read-only commands such as Sheets reads or Calendar list calls.
3. Require explicit approval for write actions such as Gmail send or Sheets append.
4. Audit external CLI usage in logs or task traces.
5. Reject raw `gws ...` execution and prefer `onecli exec -- gws ...`.

## Doctor Expectations

`myclaw doctor` treats Google access as optional.

- If neither OneCLI nor Google host CLIs are configured, doctor stays focused on core runtime setup.
- If OneCLI credential mode or Google host CLIs are present, doctor reports whether the `onecli` and `gworkspace` path looks usable.

## When To Build More

Only add deeper MyClaw integration when email or Google workflows must become first-class runtime behavior.

Examples:

- Gmail as a native channel
- webhook ingestion owned by MyClaw
- custom workflow state tied directly to Google resources

Until then, prefer the host CLI path because it is faster to ship, easier to audit, and aligns with the current runtime model.
