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
- Treat `/v1/webhooks` as outbound callback delivery only. Signed inbound sidecar systems use external ingress records under `/v1/ingresses`; do not describe webhooks as ingress authority.
- Job docs must preserve the settings/runtime boundary: job instances, prompts, schedules, leases, runs, notification targets, and job-scoped tool extras are Postgres runtime state, not `settings.yaml` desired state.
- Admin docs must distinguish provider-scoped agent DM admins from conversation-scoped group/channel approvers; do not imply Slack, Teams, Telegram, Web, or local user ids are interchangeable.
