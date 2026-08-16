---
slug: capsafe-1
title: CAPSAFE-1 Refactor CLI-command capability permissions to a simple prefix-wildcard model (delete the widening machinery)
status: confirmed
saved: 2026-08-16T00:00:00+00:00
---

# CAPSAFE-1 — Refactor CLI-command capability permissions to a simple prefix-wildcard model

## Problem

The CLI-command capability permission system is too rigid and, to compensate, has grown a
large, brittle apparatus that is now KILLING the feature — an agent that holds a capability
still cannot do simple, safe things (e.g. a comma-safe Google Sheets write with
`gog … --values-json`), so it cannot help the user.

Root of the rigidity: the reviewed command template match is ARITY-EXACT and forbids flags.
`gog sheets update * * *` means "exactly three arguments, none starting with `-`". So
`--values-json` is refused before the CLI ever runs
(`apps/core/src/jobs/structured-local-cli-invocation.ts`), and there are two independent
"exactly one prefix" gates (`capability-template-compiler.ts:50`,
`ipc-capability-run-handler.ts:86-96`). To allow a new shape you must invoke the entire
widening apparatus — the template compiler, the amendment/proposal flow, the mismatch→card
path, and (as recently proposed) a classifier "shape" family + `documentedFlags` metadata.
That apparatus exists ONLY because the base match is too rigid, and it is the complexity that
is breaking the feature.

## Reference: how simple this is elsewhere

Claude Code models CLI permission as a plain prefix rule: `Bash(<prefix>:*)`, where `:*` means
"anything after the prefix". `Bash(gog sheets update:*)` allows `gog sheets update <anything,
including flags like --values-json>`. No arity check, no per-argument wildcards, no in-prefix
flag restriction, no compiler, no amendment flow, no classifier. Grant a command prefix once;
anything under it runs; the prefix is the security boundary. Codex CLI and similar agent tools
use comparably simple sandbox/allowlist models, not arity-exact per-arg matching.

## Intent (extreme simplicity via DELETION, not addition)

Adopt the prefix-wildcard model. Change one semantic: a trailing `*` in a reviewed capability
command template means "match everything after the prefix" (Claude Code's `:*`), NOT "exactly
one non-flag argument". Then `gog sheets update *` already authorizes
`gog sheets update <ss> <range> --values-json <json>` — nothing to widen, ever.

This lets us DELETE, not build:
- the arity-exact + no-flag-in-positional matching in `structured-local-cli-invocation.ts`;
- the entire `capability-template-compiler.ts` (no widening needed);
- the amendment/proposal flow + the mismatch→card/instruction path;
- any `documentedFlags` schema field and `capability_shape` classifier family (never build);
- the `request_access` command-shape plumbing.

New model: a capability = a granted command prefix; any invocation matching the prefix runs.
Changing what is allowed is a one-line human edit of the prefix (rare). No runtime negotiation,
no LLM authorization of command shapes.

## Acceptance criteria

1. A capability whose reviewed template is a command prefix authorizes ANY invocation matching
   that prefix, flags included (e.g. `gog sheets update *` allows `--values-json`).
2. The prefix (executable + literal subcommand path) remains a hard boundary: an invocation
   that does not match the prefix is refused.
3. The template compiler, amendment/proposal flow, mismatch→card path, and shape-classifier
   apparatus are DELETED (or reduced to the prefix matcher), not extended.
4. Existing reviewed templates migrate cleanly to the prefix-match semantics with no capability
   silently over- or under-authorized.
5. Live proof: the KnackLabs agent writes to Sheets via `--values-json` with no widening step,
   no card, no dead-end.

## Out of scope

- Non-CLI capability kinds. The per-job KnackLabs template hack.

## Codex sol/xhigh design pass (stage 1)

WEB-SEARCH how Claude Code, Codex CLI, and other agent tools implement CLI-command permission
wildcards (prefix/glob allowlists), and cite the simplest proven model. Then produce the
CONCRETE deletion refactor for myclaw: the exact matcher change in
`structured-local-cli-invocation.ts`, every file/module to DELETE or shrink, how existing
reviewed templates migrate to prefix semantics, the security analysis of the prefix-only
boundary (what becomes unbounded within a prefix and why that is acceptable, matching Claude
Code), and the minimal test set. Favour deletion; the smallest change that makes a held
capability's prefix authorize any invocation under it. Read AGENTS.md + ponytail first.
