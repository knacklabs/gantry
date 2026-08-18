# Windows support

## Supported native path

Use Windows with Git for Windows (including Git Bash) and Python 3.10 or
newer. From Command Prompt or PowerShell, `forge.cmd` is the entry point. It
checks `py -3`, `python`, then `python3` for a supported interpreter before
handing off to Git Bash; when Git Bash is unavailable, it runs Forge with the
interpreter it found.

## Remediation

If no suitable Python is available, `forge.cmd` uses winget from its canonical
WindowsApps location to install Python in user scope, refreshes PATH from the
known per-user install location, and retries once. `forge init`, `forge adopt`,
and `forge upgrade` also run the fast hook check on Windows. When it is red,
they run the same user-scope prerequisite remediation and print a named
`doctor --fix` or manual-installer step if the check remains red.

Forge never launches an elevated process with `RunAs`. A package installer
may show its own Windows prompt. If winget or a prerequisite cannot complete
in user scope, install Git for Windows or Python from the URL printed in the
red row and rerun the command.

## Delegation

Native Windows delegation is supported. `forge delegate` launches, supervises,
and reaps the Codex worker tree on Windows, and a write delegation passes
`--write` to select the companion's workspace-write sandbox.

An explicitly unelevated sandbox is deferred. The companion does not expose an
unelevated sandbox option, and Forge does not change user-global Codex
configuration to simulate one. Run Forge from a normal, unelevated prompt.

## Encoding

Forge repository text and machine-consumed text use explicit UTF-8 on every
I/O boundary. Diagnostic output may replace undecodable bytes so a status or
doctor command can still explain the failure; evidence and canonical records
decode strictly, and byte-exact paths remain bytes. This convention is recorded
in decision 0043 and enforced by `check_encoding_hygiene.py`.

Deferral D-0026 parks the same sweep for inline Python in the roadmap-gate and
PR-link workflows until a gate log shows mojibake or a decode failure, or a new
inline workflow parser is added. Those snippets are outside the harness-script
surface enforced by the current checker.

## WSL2 escape hatch

WSL2 is optional, not a prerequisite. Use it as an escape hatch when policy or
machine configuration prevents the supported native Windows path from
converging; inside WSL2, follow the normal Linux setup.
