---
slug: clirun-1
title: Structured invocation for local-CLI capabilities
status: confirmed
saved: 2026-08-11T03:45:41+00:00
---

# CLIRUN-1 — Structured invocation for local-CLI capabilities

## Why

A `local_cli` capability (e.g. gog/sheets) is invoked by the agent authoring a
shell string that projects to a `RunCommand` rule. Because the agent writes
shell, it appends benign post-processing (`| head`) that misses the scoped
match, drops to the non-deterministic classifier, and — on an autonomous run —
fails terminally with no approve button (decision 0115). This took down the
KnackLabs job. Safe-pipe allowlists only move the boundary and are whack-a-mole
across CLIs. The durable fix (decision 0120, Codex-critiqued) is to stop the
agent authoring shell for these capabilities: invoke them through a structured
host tool.

## Behaviour

- The agent calls a structured tool with `{ capabilityId, args: [] }` — an
  argument list, never a shell string — for a granted `local_cli` capability.
- The host resolves the granted capability against current authority, validates
  the argv structurally against the capability's reviewed pattern (rejecting
  unreviewed subcommands/flags, excess args, NULs, oversized input), verifies the
  executable identity at invocation, and runs it through the EXISTING sandboxed,
  output-bounded runtime executor. Bounded output is returned.
- No shell string exists, so pipes/redirects/`&&`/globs/substitution are
  impossible and authorization is the deterministic "is this capability granted?"
  check — no classifier in the loop.
- At cutover the capability-derived `RunCommand` projection is retired for
  `local_cli` (no dual-run); a genuine pipe becomes a separately reviewed
  composite capability.

## Acceptance criteria

- A granted `local_cli` capability runs via the structured tool on an autonomous
  run with no shell string, no classifier consult, and bounded output; an
  unreviewed subcommand/flag or excess argument is rejected.
- Execution reuses the existing sandbox + output-boundary + timeout/cancellation;
  the executable identity is verified at invocation.
- After cutover the RunCommand projection no longer authorizes these
  capabilities; existing scheduled jobs invoke via the structured path.

## Source

docs/architecture/cli-capability-structured-invocation-design.md (design +
Codex critique); decision 0120.
