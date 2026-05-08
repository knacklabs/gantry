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
- Admin docs must describe conversation-scoped approvers for both direct/private and group/channel conversations; do not imply Slack, Teams, Telegram, Web, or local user ids are interchangeable.
- Memory docs must describe the current first slice truthfully: flattened `memory_items` is canonical, lexical retrieval is active, vector retrieval is inactive until item embedding indexing/querying ships, `memory_subjects` is not current active schema, and MyClaw has no `PostCompact`/`compact_summary` prompt-replay behavior.
- Memory and continuity docs must describe digest-first fresh-run context hydration (recent persisted session digests before active durable memory items), dreaming-only automatic durable promotion/update, and embedding work limited to dreaming promotion/update.
- Continuity docs must preserve the clean-cut contract: unsupported old continuity rows fail closed and are not imported, backfilled, or repaired.
- Memory tool docs must keep `memory_save` limited to canonical direct-save kinds (`preference`, `decision`, `fact`, `correction`, `constraint`) and state that common/global writes require approved admin or service authority.
- SDK docs must describe `sessions.sendMessage` as durable acceptance into the runtime event stream. Do not imply `accepted` or `acceptedEventId` means synchronous model completion or provider/channel delivery success.
