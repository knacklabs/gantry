# Degraded Mode

`forge delegate` is the sole normal path for product and canon writes. The
orchestrating session's hook denies those writes even with an approved plan;
planning mode and the older quickfix/lite windows do not lift that lock.

`codex-plugin-cc` is required. Repair an outage first:

```bash
./forge doctor --fix
```

On Windows, see [Windows support](windows.md) for native prerequisite
remediation and the optional WSL2 escape hatch.

Read-only discovery remains available through `/codex:rescue`. The companion
guard also admits direct, unwrapped `status`, `task-resume-candidate`, and
`task` invocations using only the approved read-only flags. Quoting does not
change that decision. Sensitive or unknown overrides, raw `codex exec`,
write-shaped companion calls, and executor-wrapped calls stay denied.

## The single write exception

If the companion is broken and product work cannot wait, explicitly open a
degraded window with a reason:

```bash
./forge mode degraded start --reason "companion outage blocks the active task"
```

The window is recorded on the quickfix ledger with `kind: degraded`. It may
claim at most five distinct locked files. Each direct Edit, Write,
NotebookEdit, or recognized Bash write claims its locked target before the
tool runs; a sixth file is denied. Recursive or globbed operations whose file
set cannot be bounded are denied. `docs/`, `plans/`, `prototype/`, `.gstack/`,
recorders, scratchpad, and git operations keep their normal routing.

The window is an outage valve, not approval or a second implementation mode.
Keep the active task scope, tests, verification, and review contract unchanged.
Close it as soon as the bounded work is complete:

```bash
./forge mode done
```

`mode done` writes the claimed files to the ledger's done record and removes
the active window. Declare its `Q-...` id in the PR body (`Ticket: Q-...`).
Gate A still requires every completed story and window record in the PR to be
declared; the degraded record gets no special exemption.

Restore the companion and return to `./forge delegate <task-id>` for any
remaining locked write.

## PR-link fallback when CI is unavailable

Gate B normally links a completed story to its pull request automatically
through `.github/workflows/pr-link.yml`. Use the manual command only when that
workflow cannot run:

```bash
./forge pr-link <STORY> <PR-REFERENCE>
```

This is a CI-unavailable fallback, not the normal PR-linking path.
