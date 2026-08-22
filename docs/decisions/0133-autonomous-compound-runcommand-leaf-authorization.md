---
status: proposed
confirmed_by: ''
date: 2026-08-22
stories: [NOTIFY-2]
---

# Autonomous control-flow compounds require per-leaf RunCommand grants

## Context

An autonomous run can issue a control-flow compound even when each command is
already covered by a reviewed RunCommand rule. Treating the compound as one
command incorrectly denies that existing authority. Pipes are different: they
transfer data between commands and cannot be authorized from independent leaf
rules.

## Decision

Allow an autonomous control-flow compound only when it contains no pipe and
every parsed command leaf independently matches an existing granted RunCommand
rule. Do not grant compound-wide authority; a pipe remains a hard boundary.

## Consequences

No new authority is created: every allowed leaf was already individually
authorized. Compounds with an ungranted durable leaf can request the complete
set of per-leaf rules; piped or nondurable compounds remain instruction-only.
