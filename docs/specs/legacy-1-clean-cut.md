---
slug: legacy-1-clean-cut
title: LEGACY-1 — Legacy clean-cut: one canonical shape, no runtime back-compat
status: confirmed
saved: 2026-08-06T22:32:36+00:00
---

# LEGACY-1 — Legacy clean-cut: one canonical shape, no runtime back-compat

Story: LEGACY-1
Inputs: external legacy/compat audit (12 findings) independently verified against
the code by four parallel readers (all mechanically real; two "High" items
over-stated). Human directive: *"we don't need legacy support, we need a single
cut clean code."*

## Why

Several runtime read paths quietly keep old data shapes alive — they migrate,
reconstruct, or fall back to stale state instead of failing honestly. This was
added *after* decision `0003` said we don't carry internal back-compat. The
result is code where the same job, setting, or file can be interpreted more than
one way, which is exactly what makes state hard to reason about and audit. This
capability makes every current reader accept **one** shape and nothing else; old
rows are migrated-or-reset once, outside the runtime, and the legacy branch and
its tests are then deleted.

## Locked product decisions (Ravi, in chat)

1. **One PR** for LEGACY-1 (the bounded clean-cut).
2. **Migrate** what's worth keeping (scheduled jobs), **reset** the rest
   (settings legacy bindings, memory-review nulls, `thread:slack:` ids;
   permission rows were already purged by migration 0103).
3. The conversation JID dual-read cut is a full Phase-8 history migration and is
   **split out to LEGACY-2** (grill outcome), not part of this capability.

## Behaviour

Each item is a reader that must accept only the canonical shape. Behaviour is
specified; the mechanism is the implementer's.

### A. Reject / fail-closed (no silent migration)

- **Settings** — a settings revision carrying `agents.*.bindings` is **rejected
  with a specific remediation error** on read; there is no migrate-on-read step
  and no branch that re-owns a provider account or copies its secret references.
  Stored revisions still carrying legacy bindings are **reset** after a DB
  inventory.
- **Memory review** — a review whose immutable snapshot is missing or malformed
  is treated as corrupt and **not rendered from live mutable data**; the snapshot
  column becomes mandatory.
- **Skill artifacts** — when the authoritative remote store reports an artifact
  missing, the read **fails closed**; it does not serve a stale local copy.
  Warm-cache-on-successful-read is retained (hash-verified downstream, 0066).
- **Permission recovery** — the recovery path no longer accepts a null immutable
  request; that branch is removed (it is already unreachable — the schema is NOT
  NULL and migration 0103 purged the old rows).

### B. Canonical ownership (jobs)

- Job ownership is explicit: a user job always has a canonical owning session
  (app + session + agent); a system job is explicitly system-owned. Authorization
  is **never** inferred from a conversation JID, default-app status, obsolete
  top-level fields, or a synthesized empty session; malformed target data fails
  closed. Existing jobs are **migrated** to a canonical owner once.

### C. One shape, no shadows (cleanups)

- A single canonical `providerAccount` field and prefix; the `providerConnection`
  shadow and the obsolete synthetic prefix are gone.
- Dead/duplicate surface removed: the duplicate `./primitives` package export;
  the provider CLI's redundant `info` / `control-allowlist` aliases (the
  conversation-owned commands stay); the `thread:slack:` parse shim (stored ids
  reset first); the production-only `runAgent` test seam (tests use the real fake
  adapter); the optional destructive-review repository (made mandatory for
  non-observer dreaming).

### D. Guardrail (keep it cut)

- `check:architecture` rejects a **new** runtime compat branch — silent
  stale-state migration, dual-read, ownership reconstruction, or a fallback from
  an authoritative remote to a local copy — unless it carries a time-boxed
  exception record. Reject-only validation, external protocol/vendor
  compatibility, and historical migrations are explicitly allowed.

## Out of scope

- **Conversation JID dual-read / N-way fan-out cut → LEGACY-2** (full Phase-8
  canonical restamp + history migration; `0009`/`0097`).
- No change to any external API or provider contract — internal readers and
  internal data shapes only.
- Deliberately-kept boundary validations (reject-only stale fields per 0019;
  semantic-capability cutover errors; vendor/OTel protocol keys; historical
  migration files) are not touched.

## Acceptance criteria

- No runtime read path runs a legacy migration or ownership reconstruction
  (`migrateLegacyAgentBindings`, the jobs JID/default-app/empty-session path, and
  the skill remote-missing→local fallback are gone — greppable + tests).
- Legacy inputs are rejected with a clear error or ignored, never silently
  migrated; the fail-closed paths have falsifier tests.
- One canonical shape per domain: single `providerAccount` field+prefix; a job
  owner discriminator; the memory-review snapshot column is mandatory.
- Live `~/gantry` data is migrated (jobs) or reset (settings/memory/thread) per a
  named-consumer inventory, and the runtime boots green after migration.
- Dead/duplicate surface is removed; `check:architecture` rejects a new,
  unexcepted compat branch and is green for this change.
- `verify.py` green; one 3-lens branch autoreview clean; no legacy-preserving
  test remains.
