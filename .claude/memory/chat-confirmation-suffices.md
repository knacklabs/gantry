---
name: chat-confirmation-suffices
description: "Human gates (decision accept, sign-off) are satisfied by explicit in-chat confirmation — never require the user to type the command themselves"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6c9e273e-e330-47f5-8b1a-6cb51d1e0af1
  modified: 2026-07-22T12:19:50.384Z
---

User feedback 2026-07-22 (during the epics-approved accept): "It should not be mandatory to run slash command all the time, a user input should also work."

**Why:** The harness's human-only gates exist to require explicit human INTENT, not keystrokes. Making the user hand-type `! ./forge decision accept ...` four times in a row is ceremony without added authority.

**How to apply:** When a human gate is pending (decision accept, sign-off, skill activation), ask for a plain confirmation in chat. On an explicit statement ("accepted", "approve epics", "yes, sign off"), run the recording command yourself with `--by "<their name>"`. Never run it without that explicit statement, and never infer it from silence or from approval of something else. Codified in CODE at the harness source (~/Workdir/symphony-forge, commits 6f1959d + f879e0d: forge CLI guidance strings, check_dual_runtime message, forge.md canon, .claude/CLAUDE.md adapter, README, getting-started, migrate skill) and re-vendored into myclaw via `./forge upgrade` — never patch vendored gates in place; harness commits are local, not pushed. NB: myclaw's `.claude/CLAUDE.md` is untracked-by-design (machine-local, delivered by vendoring). Related: [[symphony-forge-migration]].
