---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-07
stories: [LEGACY-1]
---

# Single Canonical Shape: Readers Reject Legacy, No Runtime Migration [LEGACY-1]

## Context

An audit found several runtime read paths that silently keep obsolete data
shapes alive — added *after* `0003-early-stage-no-backcompat`, which forbids
internal back-compat and requires the owner to migrate-or-reset old state and
then delete the old branches/tests. Four verifiers confirmed each is real. The
human's directive: *"we don't need legacy support, we need a single cut clean
code."*

## Decision

Current writers produce one canonical shape per domain; current readers accept
**only** that shape. A legacy-shaped input is **rejected with a specific
remediation error, or ignored — never silently migrated or reconstructed at
runtime.** Old rows are migrated-or-reset **once, outside the runtime**, and then
the reader branch and its tests are deleted.

Per area (LEGACY-1):
- **Settings** `agents.*.bindings` → the reader raises a specific remediation
  error (no `migrateLegacyAgentBindings` on the read path); stored revisions
  carrying legacy bindings are **reset** after a DB inventory.
- **Memory review** — a missing/malformed immutable snapshot **fails closed**
  (never re-reads live mutable items); the column becomes `NOT NULL`.
- **Skill store** — a remote-missing artifact **fails closed** (no fall-through
  to a stale local copy); warm-cache-on-success is kept (hash-verified, 0066).
- **Permission recovery** — the null-request branch is **deleted** (unreachable:
  schema `NOT NULL` + migration 0103 purge).
- **Shadow/dead surface** — `providerConnection`, `./primitives`, provider CLI
  aliases, `thread:slack:`, the `runAgent` prod-type seam, and the optional
  brain-review repo are removed/required.

Migrate-vs-reset (human choice): **migrate** what's worth keeping (scheduled
jobs — see 0114; conversation history is LEGACY-2), **reset** the rest (settings
bindings, memory-review nulls, `thread:slack:` ids; permission rows already
purged).

## Consequences

- No dual-read anywhere in scope; one shape to reason about and audit.
- Boot may reject a genuinely stale revision — the owner resets it, rather than
  the runtime silently rewriting it.
- Enforced going forward by `0113` (architecture-check guardrail).
- Relates `0003`/`0007`/`0025`/`0066`/`0019`. Conversation restamp is deferred to
  LEGACY-2 (Phase-8 program, `0009`/`0097`).
