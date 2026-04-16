# Contributing

## Before You Start

1. Search for existing issues or PRs before opening a new one.
2. Keep each PR focused on one change.
3. Read the project philosophy in [README.md](README.md). Core changes should stay broadly useful, small, and easy to understand.

## What Belongs In Core

Good candidates:

- bug fixes
- security fixes
- simplifications
- documentation improvements
- maintainability work that reduces complexity

Poor candidates for core:

- broad feature additions
- extra compatibility layers
- project-specific workflow customizations
- code that most users will not need by default

If a capability is useful but optional, prefer delivering it as a skill or a narrow branch-based add-on instead of adding it to the default runtime.

## Skill Types

MyClaw uses [Claude Code skills](https://code.claude.com/docs/en/skills) to install, guide, or automate optional capabilities.

### Feature skills

Feature skills pair a `SKILL.md` with a `skill/*` branch that carries the code changes.

- `SKILL.md` explains how to apply the branch and finish setup
- the branch contains the actual source changes
- maintainers can merge `main` forward into the skill branch to keep it current

Examples:

- `/add-telegram`
- `/add-slack`
- `/add-discord`
- `/add-gmail`

### Utility skills

Utility skills ship their own supporting files inside the skill directory. The skill installs or copies those files without requiring a branch merge.

### Operational skills

Operational skills are instruction-only workflows such as setup, debugging, or maintenance guidance.

### Custom runtime skills

Custom runtime skills live in the agent environment and shape how runtime agents behave.

## SKILL.md Rules

All skills follow the Claude Code skill format:

```markdown
---
name: my-skill
description: What this skill does and when to use it.
---
```

Keep skills maintainable:

- keep `SKILL.md` focused and under 500 lines
- put code in separate files instead of inline markdown blocks
- keep instructions concrete and reproducible
- document prerequisites and verification steps

## Testing

Test the change you made, not the entire universe.

- For docs-only work, run scoped link, search, or markdown sanity checks.
- For code changes, run the smallest command set that proves the behavior.
- For skills, exercise the skill end to end on a clean checkout when possible.

## Pull Requests

A good PR description should answer:

- what changed
- why it changed
- how it works
- how it was tested

Keep it short and factual. If a change affects a user workflow, call that out plainly.
