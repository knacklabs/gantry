# PR #237 validation

Date: 2026-07-20  
PR: #237, `develop` -> `main`  
GitHub head: `7b2d63d15e97d7dfb0be7451c7269b56bf8e4428`  
Verdict: **REWORK**

## Executive result

The PR does not fix four of the five requested defect areas. The four named source files are unchanged relative to current `main`, and the remote-only tip commit does not touch them. The PR preserves inventory-only installation—there is no blanket install-time tool grant—but its new capability-sync path is not sufficient to guarantee curated read/write separation. It also introduces three high-risk regressions: recursive settings-key normalization can rename user-owned identifiers, startup cursor capping can silently skip durable messages, and the deployment workflow makes the runtime container privileged while deleting Docker security options.

Green CI is not enough to merge this shape. The PR needs a smaller, current-main-based rework that fixes the named invariants and removes the unrelated/security-sensitive changes.

## Evidence and freshness

The requested command was attempted exactly:

```text
git fetch origin develop && git diff main...origin/develop
```

The fetch was blocked by the managed workspace because `.git/FETCH_HEAD` is read-only:

```text
error: cannot open '.git/FETCH_HEAD': Operation not permitted
```

The existing local `origin/develop` was `0ec4dda44b1ad4cbbb2f31a0468e64a527649afb`, one commit behind GitHub. Freshness was recovered read-only by checking `gh pr view 237` and inspecting commit `7b2d63d...` and its remote file contents through `gh api`. That tip changes only:

- `apps/core/src/cli/mcp.ts`
- `apps/core/test/unit/cli/mcp.test.ts`
- `apps/core/src/channels/slack/permission-approval-delivery.ts`
- `apps/core/test/unit/channels/slack.test.ts`

The current GitHub PR has 62 files, 2,940 additions, and 234 deletions. All four GitHub checks (`ci`, `image`, `scaffold-check`, and dev deploy) pass. GitHub still reports `mergeable: UNKNOWN`; the local merge analysis is recorded below.

## What the PR actually changes

1. **MCP capability inventory and synchronization.** Adds `McpCapabilitySyncService`, an `mcp:admin` Control API route, CLI `mcp sync-capability`, remote HTTP/SSE CLI connect support, OpenAPI/contracts, audit events, and focused tests. The service discovers source tools and appends pattern-matching names to an existing semantic capability.
2. **Permission and Gantry-tool recovery.** Allows exact third-party MCP tool names only as transient `request_access` grants; returns recoverable MCP proxy errors; makes scheduler tools exact durable Gantry-tool selections; adds provider-account-aware IPC parsing/routing; and updates access summaries and locked-tool exclusions.
3. **Settings revisions and desired-state mutation.** Reads persistent tool grants from the latest revision with an expected-revision guard, recursively converts stored camelCase keys, repairs missing legacy provider secret refs, and adds settings/restart tests. It also adds an unused legacy Slack route-seeding helper.
4. **Slack and runtime behavior.** Gives question buttons unique indexed action IDs, accepts those IDs in handlers, normalizes inline bot mentions, forwards provider-account context, makes approval-delivery failures visible, and adds a 15-minute default cap when recovering a cursor from the last bot reply.
5. **Jobs, deployment, contracts, and tests.** Strips raw tool-call markup from job summaries, wires a CAW ATS secret into the dev ECS task, changes the task to privileged mode, extends contracts/OpenAPI, and adds broad unit coverage. No generated SDK file or typed SDK method is included for the new endpoint.

## Surface Impact Matrix

| Surface | Classification | Evidence |
|---|---|---|
| Runtime behavior | Changed | MCP recovery, exact transient access, cursor recovery, scheduler gating, Slack trigger behavior |
| `settings.yaml` | Changed | latest-revision mutations, revision parsing/normalization, provider secret-ref repair |
| Postgres/runtime projection | Changed | semantic capability catalog writes, MCP audit event, revision-backed projection sync |
| Control API | Changed | `POST /v1/mcp-servers/{serverId}/sync-capability` |
| SDK/contracts | Changed but incomplete | contracts and OpenAPI change; no `packages/sdk/**` change |
| CLI | Changed | MCP connect/sync and Gantry-tool access display |
| Gantry MCP tools/admin skill | Changed but incomplete | request-access and scheduler tool surface changes; admin skill documentation is not updated |
| Channel/provider adapters | Changed | Slack ingest, questions, approval delivery, provider-account routing |
| Docs/prompts | Changed but incomplete | agent prompt and runner `AGENTS.md` change; no architecture/decision document for capability sync or cursor loss policy |
| Audit/events | Changed | adds `capability_sync` MCP audit events |
| Tests/verification | Changed but incomplete | many unit tests and green CI; named regressions, dynamic-key preservation, SDK parity, and durable replay loss are untested |

## Requested defect classification

| # | Classification | Validation |
|---|---|---|
| 1. Bound inventory-only servers disappear after any MCP tool rule | **NOT TOUCHED** | `authorizedMcpServerIdsForAgent` is unchanged. At `mcp-authorized-servers.ts:53-59`, an empty MCP-name set returns every active binding, but a non-empty set returns only name-matching servers. The existing unit test explicitly expects `['mcp:github']` and excludes the other active bound server when one GitHub tool rule exists. The new sync feature makes reaching this state more common but does not repair projection. |
| 2. Recovery names hidden tools in fixed-image/locked modes | **NOT TOUCHED** | `protectedCapabilityRecovery()` still names `request_mcp_server` at `tool-execution-policy-service.ts:541-543`, and third-party autonomous recovery still emits a literal `request_mcp_server` call at `:560-563`. The PR changes only exact Gantry admin/scheduler recovery at `:557-558`. Locked projection still removes authority-changing request tools at `gantry-mcp-tool-surface.ts:190-197`. |
| 3. Bind/install is rolled back when settings sync fails | **NOT TOUCHED** | `ipc-skill-permission-review.ts:146-173` still wraps install, bind, and settings sync in one compensation block and rolls back the skill binding on any sync error. `ipc-admin-handlers.ts:752-782` still rolls back the connected MCP server after `syncApprovedCapabilitySettings` fails. Neither file is changed by the PR. |
| 4. Desired-state replacement drops concurrent installed bindings and inactive MCP aborts reconcile | **NOT TOUCHED** | `desired-state-capability-reconcile.ts:83-107` still replaces all tool/skill/MCP bindings from settings. `:309-320` still rejects an absent, cross-app, or inactive configured MCP source and fails the whole reconcile. The file is byte-identical between current `main` and PR head. |
| 5. Settings-revision and Slack seams named in the title | **PARTIAL** | The PR correctly bases persistent grant writes on the latest revision (`restart-sync.ts:177-220`), adds stored-field alias handling, fixes indexed Slack question actions, improves bot-mention normalization, threads provider-account identity, and reports approval-delivery failure. However, the settings normalizer corrupts dynamic identifiers, the Slack registration helper is dead legacy code, the SDK is not regenerated, and the unrelated cursor/deployment changes introduce blockers. |

## Product-model alignment

There is **no blanket tool grant on MCP installation** in this PR:

- `request_mcp_server` still declares `activation: 'source_inventory_only'` and tells the approver that durable action authority requires a reviewed capability (`ipc-admin-handlers.ts:718-742`). The post-install receipt repeats that rule at `:784-807`.
- The remote CLI connect tip creates a server and binds it to the agent; it does not select a semantic capability (`cli/mcp.ts` at remote head `:72-119`). Binding `allowedToolPatterns` remains source scope, not runtime action authority.
- Exact third-party MCP recovery forces `temporaryOnly: true` (`runner/mcp/tools/capabilities.ts:299-305`), so it cannot become durable exact-tool authority.
- Capability sync requires an existing semantic capability, an MCP source match, non-empty reviewed source patterns, and `mcp:admin` (`mcp-capability-sync-service.ts:147-185`; `routes/mcp-servers.ts:218-253`).

The capability-sync implementation is nevertheless **only partially aligned** with curated read/write capabilities. Its only per-tool admission check is name-pattern membership (`mcp-capability-sync-service.ts:195-210`), and one non-dry-run request (the API defaults `dryRun` to `false`) appends every currently visible match to the existing capability. It does not classify or confirm read versus write tools, require a reviewed version bump, remove stale bindings, or use optimistic concurrency when replacing the catalog row (`:274-318`). A broad pattern such as the test's `itops_*` can therefore fold all matching actions into one capability. That is not an install-time blanket grant, but it is weaker than the user-confirmed curated/read-write-separated model.

## New defects introduced by the PR

1. **HIGH — recursive alias conversion can rename durable identities.** `normalizeStoredRevisionAliases` recursively rewrites every object key (`runtime-settings-compact.ts:99-110`) and is applied to the entire settings document (`:294-313`). The alias set includes plausible user-controlled map keys such as `displayName`, `defaultModel`, and `providerAccount` (`:61-96`). An agent folder, provider-account ID, conversation ID, installed-agent key, or model alias with one of those values is silently renamed. Tests cover field aliases but not identity-key preservation.
2. **HIGH — cursor recovery silently discards older pending messages.** The new default is 900,000 ms (`config/index.ts:486-492`). If the last bot cursor is older, startup advances it to `now - 15 minutes` with id `\uffff` (`runtime-app.ts:421-454`), skipping every durable user message between the real cursor and the cap. This is message loss, not replay bounding, and the new non-secret behavior is hidden in an environment variable rather than `settings.yaml`.
3. **HIGH/SECURITY — dev deployment removes isolation and runs privileged.** The workflow deletes `dockerSecurityOptions` and sets `.privileged = true` (`gantry_dev_deployment.yml:54-73`) while also injecting a deployment-specific secret. This is an unreviewed security-boundary expansion bundled into an MCP/settings fix and contradicts the PR body's claim that sandbox/security settings were preserved.
4. **MEDIUM/HIGH — capability sync is additive, in-place, and not concurrency-safe.** The service only appends matching tool names and never removes retired bindings (`mcp-capability-sync-service.ts:195-220`). It writes the same catalog row without a version/CAS guard (`:274-300`). Stale permissions can revive if a name is reused, and concurrent capability review/catalog edits can be lost.
5. **MEDIUM — public API cutover is incomplete.** The PR adds a contracts schema and OpenAPI operation but changes no `packages/sdk/**` file, so the generated SDK has no typed operation/client surface. Separately, new `cli/slack-registration.ts` has no references and models rejected legacy `providerConnections`/`bindings`; it should be deleted rather than carried into the desired-state cutover.

## Merge-conflict surface

### Current `main`

- Merge-base used: `e803e21fa1facade8720d8c8b2a624aa8ff8a2da`.
- There are **zero overlapping paths** between the PR's 62 paths and changes from that merge-base to current `main` (`2a6ea1c366592431b08e724d90e09161284bc16d`).
- Read-only `git merge-tree` for local PR head reported no `changed in both` or conflict markers. The remote-only tip paths are also untouched on current `main` since the merge-base.
- Expected textual result: clean merge. GitHub's current `mergeable: UNKNOWN` prevents treating this as server-confirmed.

This does not reduce the behavioral blockers above; the PR can merge cleanly and still be incorrect.

### `feature/ponytail-audit` committed phases

Compared against committed ponytail head `53069146baa93dbaeeff88b165a8cf3e98faf4ff`, the PR overlaps **19 paths**:

| Area | Overlapping paths |
|---|---|
| Settings/runtime | `runtime-app.ts`, `config/index.ts`, `restart-sync.ts`, `runtime-settings-compact.ts`, `settings-import-service.ts`, `ipc-route-authorization.ts` |
| Slack/CLI | `channel-message-ingest.ts`, `channel-state.ts`, `permission-approval-delivery.ts`, `user-question-interactions.ts`, `cli/group.ts` |
| Public API | `openapi-operation-schemas.ts` |
| Tests | matching runtime-app, Slack, restart-sync, runtime-settings, settings-import, OpenAPI, and IPC-route tests |

The local three-way merge shows one direct textual conflict in `apps/core/test/unit/config/settings-import-service.test.ts`. The other overlaps currently auto-merge, but several are semantic conflicts:

- Ponytail Phase 1-3 changes the settings-authority/revision and route-identity model in the same files. PR alias repair and latest-revision mutation must be re-derived on the ponytail shape, not accepted as an automatic merge.
- Ponytail Phase 4 enforces contracts -> OpenAPI -> SDK flow; PR #237 stops at contracts/OpenAPI.
- Ponytail deletes `desired-state-capability-reconcile.ts`. That deletion must remain: resolving the merge by restoring the PR/main file would reintroduce defect #4.
- The remote-only Slack approval-delivery change is in a ponytail-overlapped file but touches a separate hunk and should auto-merge; it still needs functional retesting with ponytail approver identity changes.

## Required rework before merge

1. Fix and test named items 1-4: project all active bound MCP sources while separately gating callable tools; make recovery surface-aware; decouple successful bind/install from fallible settings export; and reconcile settings without silently deleting concurrent approved bindings or failing the whole app on one inactive optional source.
2. Redesign capability sync as an explicit reviewed versioned replacement with read/write separation, stale-binding removal, and concurrency protection; keep install inventory-only and exact third-party recovery transient.
3. Replace recursive alias rewriting with schema/path-scoped field normalization that never rewrites dynamic map keys; add collision and identity-preservation tests.
4. Remove the cursor-forward data-loss behavior and the privileged deployment mutation from this PR. If replay retention or sandbox privilege is required, specify it separately with a Surface Impact Matrix, security review, and durable-message semantics.
5. Complete contracts -> OpenAPI -> generated SDK/client parity, delete the orphan legacy Slack helper, then rebase/reconcile against the ponytail settings/public-contract phases and rerun focused plus branch-wide checks.

## Verification record

- `gh pr view 237 --json files,body` — inspected.
- Current remote head, commit list, remote-only patch, and affected remote file contents — inspected through `gh`/GitHub API.
- `git diff main...origin/develop` and targeted branch file traces — inspected from the local head one commit behind, with the missing tip inspected separately.
- `git diff --check main...origin/develop` — clean for the local 61-file head.
- `gh pr checks 237` — all four reported checks pass.
- `git merge-tree` and path-set comparisons — current-main and ponytail surfaces recorded above.
- No source files, branch refs, commits, merges, or runtime state were modified. No local PR tests were rerun because the managed checkout could not fetch/materialize the current remote head without repository writes; CI status is evidence of execution, not evidence against the uncovered behavioral gaps.
