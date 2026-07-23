---
name: memory-lives-in-repo
description: STANDING — shared dev memory lives in the repo at .claude/memory/, not a personal ~/.claude dir
metadata:
  type: feedback
---

Shared dev memory MUST live in the repo at `.claude/memory/` so the whole team
and any coding agent shares it — NOT in a personal `~/.claude/projects/.../memory`
directory.

**Why:** memory on one dev's machine can't be shared; the user wants durable repo
knowledge (decisions, gotchas, in-flight work) available to every dev and agent.

**How to apply:** write new memory notes into `.claude/memory/` in the repo and add
the one-line pointer to `.claude/memory/MEMORY.md`. Migrated 2026-07-23 via PR #272
(`.gitignore` un-ignores `.claude/memory/`). The personal dir may still exist as a
recall cache, but the repo copy is canonical — update it, not the personal one.
