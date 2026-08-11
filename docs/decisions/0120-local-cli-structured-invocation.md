---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-11
stories: [CLIRUN-1]
---

# Local-CLI capabilities are invoked structurally, not as agent-authored shell

## Context

A `local_cli` semantic capability pins its executable (`executablePath`,
`executableHash`, `commandTemplates`) but its only invocation path projects to a
`RunCommand(<template>)` rule the agent fills in as a shell string
(`semantic-capabilities.ts:202-206`). Because the agent authors shell, it can
append benign post-processing (`gog sheets get … | head`) that misses the
per-leaf scoped match, drops to the non-deterministic risk classifier, and — on
an autonomous run — becomes a terminal, non-grantable denial (0115). Observed
live on the KnackLabs job. Symptom patches (safe-pipe allowlists) only move the
boundary and are whack-a-mole across CLIs. A read-only Codex critique of the
design confirmed the direction and hardened it
(`docs/architecture/cli-capability-structured-invocation-design.md`).

## Decision

A `local_cli` capability is invoked through a **structured host tool** that takes
the arguments as a list, never a shell string. The host:

- resolves the granted capability against current app/agent/person authority;
- validates the argv structurally against the capability's reviewed pattern —
  rejecting unreviewed subcommands/flags, excess arguments, NULs, and oversized
  input (a pinned executable alone is insufficient, because flags like
  `--config`/`--output`/`--account` change behaviour without shell syntax);
- verifies the executable's identity at invocation (hash / content-addressed
  path), closing the executable-replacement TOCTOU gap;
- executes through the **existing sandboxed, output-bounded runtime executor**
  (reusing its truncation, streaming, timeout, cancellation, and audit
  redaction), not a bare host `execFile`;
- returns bounded output.

No shell string is ever composed, so pipes, redirects, `&&`, globs, and command
substitution are structurally impossible, and authorization is the deterministic
"is this capability granted?" check — no per-leaf shell matching, no classifier.
At cutover the capability-derived `RunCommand` projection is **retired** for
`local_cli` (no dual-run — commands have side effects); a genuine pipe becomes a
separately reviewed composite capability, not shell.

## Consequences

- The pipe/classifier/autonomous-terminal failure class is eliminated for CLI
  capabilities, and it matches how structured MCP tools already behave.
- Argv validation and invocation-time executable verification are new host
  responsibilities; they must reuse the existing matcher and executor rather than
  fork a second execution path.
- Cutover is a behaviour change: agents and existing scheduled jobs must use the
  structured tool; the RunCommand projection for these capabilities is removed.
  Rollout is staged (tool + validation first, wire the pilot capability, then
  retire the projection).
- Out of scope: MCP capabilities, skill actions, and general Bash/RunCommand for
  non-capability commands are unchanged.
