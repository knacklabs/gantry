---
slug: capability-version-bump-card
title: Capability executable update via grantable card
status: confirmed
saved: 2026-08-12T04:00:00+00:00
---

# Capability executable update via grantable card

**Status:** confirmed — Ravi, in chat, 2026-08-12 ("merge and take it as next")
**Origin:** CAPFIX-1 (decision 0122) deliberately excluded executable identity
(path/hash/version) from the amendment card — binary changes stay a separate
deliberate re-review. But every `brew upgrade gog` changes the binary hash, so
each upgrade fails EVERY capability on that executable closed with no recovery
surface. This is a when, not an if: the guaranteed next breakage class.

## Problem

`capability_run` verifies the executable's bytes against the pinned
`executableHash` (0120) and fails closed on mismatch — correct, but today the
only fix is operator surgery. The agent cannot ask, the human cannot approve,
and every scheduled job using that executable produces nothing until someone
edits the catalog by hand.

## Outcome

The CAPFIX-1 pattern applied to executable identity:

1. **Agent-raised update proposal** on an `executable_identity_mismatch`
   rejection (new `request_access` target kind): capabilityId + the observed
   current hash/version of the on-disk binary as evidence. The host verifies
   the binary itself (same in-place identity checks as invocation: outside the
   agent-writable root, not group/other-writable, hash of real bytes) — the
   agent's claim is never trusted.
2. **Plain-language card, stronger framing than a template fix**: "The tool
   behind Google Sheets was updated on this machine (v0.9.0 → v0.10.0).
   Approving trusts the new version for everything this capability already
   does." Can/cannot restated; buttons "Trust update" / "Deny". Technical
   delta (old/new hash, version strings, path) in the collapsed full view.
3. **Approval performs a CAS identity update** for ALL capabilities pinned to
   that executable path in one approval (one upgrade = one card, not one per
   capability), templates untouched, provenance + prior identity in the same
   amendment-history mechanism.
4. **Fix-and-continue**: blocked jobs resume; deny is terminal per observed
   hash (a further upgrade proposes again).

## Non-goals

- No automatic trust of new binaries under any condition.
- No template changes through this card (CAPFIX-1 owns those; a combined
  upgrade+reshape lands as two cards).
- No downgrade special-casing: any hash change is the same flow.
- No package-manager integration; the trigger is the invocation-time mismatch.

## Acceptance

- Live proof: upgrade (or reinstall) `gog`, trigger a sheets job → one card
  covering all three sheets capabilities → approve → jobs resume and write
  leads; a second upgrade repeats the flow.
- Host-verified evidence only: a forged hash/version in the proposal is
  ignored; the card shows what the HOST measured on disk.
- Deny is terminal per (executablePath, observed hash) until the binary
  changes again; timeouts/system outcomes leave pending and redispatch.
- One card per executable per upgrade, regardless of capability count.
- Card body contains no hashes/paths (collapsed details only); a non-technical
  reader decides from the version framing alone.
