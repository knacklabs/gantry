---
reader: codex (gpt-6.1-sol)
read_at: 2026-11-26T09:57:44+00:00
read_hash: fb5ee8cfebf8ee660540b810519bcb0c91720d0a
round: 3
passed: yes
doc_seen: fb5ee8cfebf8ee660540b810519bcb0c91720d0a
spec_seen: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
notes_seen: 1abe9b56c0ed1b8b3e9dcd08c692c734f56b1052
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. Unproven: item 3: changing the selected conversation leaves the previous installation’s runtime authority undefined.
   Invalidating verification and Console handoff does not disable an active installation. Specify whether switching conversations retains or disables the previous installation, including its runtime projection. Otherwise, invalidation tests could pass while the employee continues replying in an abandoned conversation.

   Disposition: keep. Behaviour now states that switching disables the earlier onboarding-created installation and its reply list and removes them from the runtime projection, and that pre-existing installations are never disabled.

2. Cut or defer: deleting unrelated web unit tests.
   A verified Slack employee does not require removing authentication, provider, skills, or Console coverage. Keep those tests unless individually obsolete; the proposed blanket reset removes safeguards outside this feature without replacement proof.

   Read-only review; runtime behaviour and tests were not exercised.

   Disposition: keep. The owner explicitly decided to reset the existing web unit tests because they are stale, and to re-add coverage later (owner, 2026-11-26). The decision record onboarding-v2-fresh-rebuild records it, and core, Postgres and end-to-end tests keep the authentication and runtime proof.

## Round 2

No findings.

## Round 3

No findings.
