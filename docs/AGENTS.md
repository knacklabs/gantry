# Docs

## Scope

- `docs/` contains active product, architecture, security, factory, and operations documentation for MyClaw.

## Rules

- Keep docs aligned with the current repo layout and runtime behavior.
- Public onboarding docs must be npm-first (`npx myclaw`) before repo-contributor paths.
- Do not leave broken links, hardcoded personal filesystem paths, or example file paths that do not exist in this repo.
- Remove template, fork, or upstream framing from active docs unless a historical note is explicitly required.
- Prefer repo-relative paths and current commands such as `apps/core/...`, `packages/agent-runner/...`, and `ops/...` when describing the codebase.
- When docs change operational commands, verify the command still exists in this repo before publishing it.
