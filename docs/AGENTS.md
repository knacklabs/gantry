# Docs

## Scope

- `docs/` contains active product, architecture, security, factory, and operations documentation for Gantry.

## Rules

- Keep docs aligned with the current repo layout and runtime behavior.
- Public onboarding docs must be npm-first (`npx gantry`) before repo-contributor paths.
- Do not leave broken links, hardcoded personal filesystem paths, or example file paths that do not exist in this repo.
- Remove template, fork, or upstream framing from active docs unless a historical note is explicitly required.
- Prefer repo-relative paths and current commands such as `apps/core/...`, `packages/agent-runner/...`, and `ops/...` when describing the codebase.
- When docs change operational commands, verify the command still exists in this repo before publishing it.
- Treat `/v1/webhooks` as outbound callback delivery only. Signed inbound sidecar systems use external ingress records under `/v1/ingresses`; do not describe webhooks as ingress authority.
- Job docs must preserve the settings/runtime boundary: job instances, prompts, schedules, leases, runs, and notification targets are Postgres runtime state, while jobs inherit target-agent tools, skills, and MCP servers instead of carrying job-scoped capability grants.
- Capability docs must keep the semantic model primary: users approve `capability:<id>` records such as `google.sheets.write`, while raw request ids, command hashes, scoped `RunCommand(...)` rules, sandbox profiles, executable paths, and provider implementation details stay in Details/audit sections.
- Local CLI capability docs must state that user-defined `local_cli` capabilities require pinned executable identity, auth preflight, protected paths, denied environment overrides, and reviewed command templates before runtime projects scoped command authority.
- Credential and runner docs must keep the broker-lane boundary explicit: `NODE_EXTRA_CA_CERTS` can derive neutral SDK/Bash CA aliases, but broker proxies and raw provider tokens must never be described as tool subprocess env.
- Permission docs must describe `SandboxNetworkAccess` as SDK-internal transient defense-in-depth, never as a persistent capability or selected agent tool. The durable user action is a semantic capability, canonical `Browser`, exact Gantry file/web facade, exact admin MCP tool, or scoped `RunCommand(...)` rule.
- User-facing runtime examples must be concise and action-first. Keep internal
  ids, tool rules, task ids, queue diagnostics, and raw logs in details/audit
  sections instead of the primary chat or notification text.
- Admin docs must describe conversation-scoped approvers for both direct/private and group/channel conversations; do not imply Slack, Teams, Telegram, Web, or local user ids are interchangeable.
- Memory docs must describe the current first slice truthfully: flattened `memory_items` is canonical, lexical retrieval is active, vector retrieval is inactive until item embedding indexing/querying ships, `memory_subjects` is not current active schema, and Gantry has no `PostCompact`/`compact_summary` prompt-replay behavior.
- Memory and continuity docs must describe digest-first fresh-run context hydration (recent persisted session digests before active durable memory items), dreaming-only automatic durable promotion/update, and embedding work limited to dreaming promotion/update.
- Continuity docs must preserve the clean-cut contract: unsupported old continuity rows fail closed and are not imported, backfilled, or repaired.
- Memory tool docs must keep `memory_save` limited to canonical direct-save kinds (`preference`, `decision`, `fact`, `correction`, `constraint`) and state that common/global writes require approved admin or service authority.
- SDK docs must describe `sessions.sendMessage` as durable acceptance into the runtime event stream. Do not imply `accepted` or `acceptedEventId` means synchronous model completion or provider/channel delivery success.
- Model docs must use alias-first vocabulary: `modelAlias`, `responseFamily`
  (`anthropic` or `openai`), diagnostic `modelRoute`, `executionProviderId`,
  `credentialProfileRef`, and capabilities. OpenRouter is route metadata, not a
  response family or top-level provider selector.
- Runtime refactor plans must keep code anchors current with repo-relative paths and verified line ranges; note stale or removed anchors in the plan instead of leaving historical paths as active guidance.
- Runtime refactor budget docs must distinguish LOCAL-35 phase checks from final PR checks: phase checks use the recorded T0 `--baseline-file`, and final/overall deletion targets use an explicit branch `--base-ref`.
