---
name: knacklabs-sanitise-project
description: >-
  Check or sanitise a KnackLabs project on demand with Symphony Forge. Use
  when someone says "Check this repo's hygiene", "Sanitise this repo", or
  asks to find and resolve deterministic repository-health issues.
---

# Sanitise a KnackLabs project

Use this runbook only when requested. It is an on-demand maintenance action,
not a scheduled job.

## 1. Locate the project and choose the mode

Run the report-only check first when the user wants an audit or when you need
to understand the repository before changing it:

```bash
TARGET="$(git rev-parse --show-toplevel)"
"$TARGET/forge" sanitise --check --repo "$TARGET"
```

When the user wants Forge to apply its unambiguously safe fixes, run:

```bash
"$TARGET/forge" sanitise --repo "$TARGET"
```

Plain `sanitise` may heal roadmap drift and untrack known cruft. It reports
issues that need judgment instead of deleting evidence or fabricating project
history.

## 2. Resolve reported items explicitly

Use the command that matches each reported item:

- Link a done story to its merged pull request:
  `"$TARGET/forge" pr-link "$STORY" "$PR_REFERENCE" --repo "$TARGET"`.
- Only when a human confirms that a historical story predates the outcome
  contract, record the reason with
  `"$TARGET/forge" project mark-predates "$STORY" --reason "$REASON" --repo "$TARGET"`.
- Complete an incomplete pending story with
  `"$TARGET/forge" roadmap fill "$STORY" --story "$USER_STORY" --ac "$CRITERION" --skill "$SKILL" --epic "$EPIC" --spec "$CONFIRMED_SPEC" --repo "$TARGET"`.
- Only when the user confirms stale task evidence can be abandoned, start the
  replacement task with
  `cd "$TARGET" && python3 factory/scripts/intake.py --issue "$ISSUE" --title "$TITLE" --discard-active`.
  `intake.py` resolves the repo from the working directory, so this destructive
  step MUST run from inside `$TARGET` — never from the harness or another repo.
- Close a crashed developer window with
  `"$TARGET/forge" mode abandon --reason "$REASON" --repo "$TARGET"`.

Secrets require rotation and redaction; untracked cruft requires an explicit
keep-or-remove decision. Resolve doctor advisories with the command printed by
the report. Never invent missing story details or delete task evidence merely
to make the check pass.

## 3. Recheck and report

```bash
"$TARGET/forge" sanitise --check --repo "$TARGET"
```

Report the safe fixes applied, the explicit resolutions recorded, and every
remaining item that still needs human judgment.
