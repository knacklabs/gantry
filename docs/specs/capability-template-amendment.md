---
slug: capability-template-amendment
title: Capability template amendment via human-approved card
status: confirmed
saved: 2026-08-11T17:10:00+00:00
---

# Capability template amendment via human-approved card

**Status:** confirmed — Ravi, in chat, 2026-08-11 (plain-language card locked: ability-terms body, technical delta collapsed)
**Origin:** live incident 2026-08-11. After the CLIRUN-1 cutover, the KnackLabs
job produced zero leads on every run: the reviewed template for
`google.sheets.values.get` is `gog sheets get *` (one argument) but the real
CLI contract is `get <spreadsheetId> <range>` — the arity-exact matcher
correctly rejects every real call ("Arguments are outside the reviewed
pattern"). No product surface can amend a capability's command templates: the
agent's definition-bearing requests are rejected on catalog conflict (correct —
anti-self-authorization), there is no CLI/settings surface, and the only lever
is raw SQL on `tool_catalog`. Ravi rejected the SQL unblock and chose to ship
the product path, leaving the job broken until it lands.

## Problem

A local_cli capability's `commandTemplates` are its authorization boundary
(decision 0120: arity-exact, deliberately rigid). When a template doesn't fit
the CLI's real argv shape, every invocation fails with a pattern error, the
job produces nothing, and the system has no safe recovery path: the agent cannot amend
the definition (by design), while no host flow files a human-reviewable fix. The mismatch class is permanent:
every new CLI capability, CLI version bump, or template authoring mistake
lands here.

## Outcome

The fix-and-continue pattern, applied to capability definitions:

1. **Host-compiled amendment proposal.** When `capability_run` rejects with a
   recognized template mismatch, the verified host handler compiles and records the only
   proposal entry. The agent-authored `request_access` amendment target is removed. A
   flagged observation proposes both full pinned-path templates: the base positional form
   and the flagged variant with flag values wildcarded. The proposal NEVER takes effect on
   its own — it is review metadata.
2. **Human approval card — plain language, not technical.** The card reads in
   ability terms, built from the capability's existing human-facing fields
   (displayName, category, can/cannot):
   - What happened: "Your lead job tried to read the Google Sheet, but the
     approved way of running that command is too narrow, so it failed."
   - What approval changes: "Approving corrects the allowed command shape.
     What I can do stays the same: <can>. What I still cannot do: <cannot>."
   - Widening is tiered (Ravi, chat, 2026-08-11): an amendment that only adds
     trailing input slots gets one soft, factual sentence — "This also lets
     the command take an extra input it couldn't before." — because with
     collapsed details the warning sentence is the approver's only signal, and
     no syntactic rule can tell a data operand from an operation selector. Any
     other change (new subcommand, added flag, changed literal, different
     executable) leads with a stronger plain warning. Nothing is warning-free
     except an exact-equivalent reshape.
   - Buttons: Approve fix / Deny. No template strings, argv dumps, ids, or
     hashes in the card body — the technical delta (current vs proposed
     patterns, failing argv) lives in a collapsed/secondary details section
     (provider-native expandable where supported) for whoever wants it.
3. **Approval updates the catalog.** On approve, the durable capability
   definition (tool_catalog row) is updated with the reviewed template(s),
   provenance recorded (who, when, from which request). Proposal identity is
   `(appId, capabilityId, canonical proposedTemplates)`; one redacted argv sample is
   evidence only. Deny is terminal for the proposal; the capability stays as reviewed.
4. **Durable fix-and-continue.** Approval inserts an app-wide recovery intent in the
   amendment transaction. Recovery retries until every affected paused job is resumed or
   superseded; the re-run invokes the CLI through the amended template without re-asking.
5. **Executable identity unchanged.** Amendment covers `commandTemplates`
   only. `executablePath`/`executableHash`/version stay immutable through this
   surface — binary changes remain a separate, deliberate re-review.

## Non-goals

- No agent self-amendment under any condition (anti-self-authorization holds).
- No relaxation of arity-exact matching (0120 stands; templates get richer,
  the matcher does not get looser).
- No hash/path/version amendment through this card.
- No bulk template-authoring UI; chat-card approval is the v1 surface.

## Acceptance

- Live proof: the KnackLabs job — the host recognizes the sheets template mismatch and
  files the compiled proposal, Ravi approves from the card, both full pinned-path templates
  are applied, and durable recovery resumes the job to write leads. No SQL, no restart.
- A denied proposal changes nothing and is not re-raised for the same canonical proposed
  templates within the reviewed definition (observed argv is not dedup identity).
- Amendment provenance is recorded and visible (who approved, when, prior
  templates retained in history).
- Card copy contains no template strings, argv, ids, or hashes in the primary
  body; a reader who knows nothing technical can decide from the can/cannot
  framing alone (technical delta available but collapsed).
- Hash/path amendment attempts through this surface are rejected.
