# PR #237 architecture and implementation-quality review

Review target: `origin/develop` at `7b2d63d15`, fetched 2026-07-20 and
compared with `git diff main...origin/develop`. Unless stated otherwise, code
line references below are to that fetched `origin/develop` tree.

## Verdict

**Do not merge PR #237 as-is. Recommendation: SELECTIVE.** Keep the small
authority/CAS, remote-MCP CLI, Slack delivery-notice, and provider-account
identity fixes. Rebuild the MCP-capability work around one reviewed pattern
authority, and drop the settings, route, deployment, and Slack compatibility
layers.

The principal problem is architectural, not stylistic. The PR turns runtime MCP
inventory into a second durable copy of reviewed capability authority
(`apps/core/src/application/mcp/mcp-capability-sync-service.ts:167-220,
:274-300`), adds recursive revision-shape compatibility
(`apps/core/src/config/settings/runtime-settings-compact.ts:27-110`), and
teaches route resolution to prefer among stale aliases
(`apps/core/src/runtime/ipc-route-authorization.ts:37-89`). Those are the three
things the simplification program says to remove: same-fact-twice, transition
readers, and consolidation that preserves divergent copies. The governing
program explicitly selects qualified stored route keys only
(`docs/architecture/ponytail-audit-2026-07-16.md:132-153`), no transition shims
(`docs/architecture/ponytail-audit-2026-07-16.md:45-47`), and one canonical live
route projection (`docs/architecture/ponytail-audit-2026-07-16.md:507-540`).

The final diff is 62 files and +2,940/-234 lines, but most of that surface is
tests and adapters for the wrong new authorities. Deleting those surfaces is
cheaper than integrating them. It also avoids rebasing compatibility code over
the ponytail branch's already-landed Phase 3 canonical-routing work and Phase 4
contract-authority work; those phases implement the direction specified at
`docs/architecture/ponytail-audit-2026-07-16.md:43` and
`:542-566`.

## Verdict matrix

| #   | Change group                                                   | Verdict         | Primary evidence                                                                                                                                                                        |
| --- | -------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Guarded settings writes use the latest revision and CAS        | **KEEP**        | `apps/core/src/config/settings/restart-sync.ts:179-205,361-380`; `apps/core/src/config/settings/settings-import-service.ts:174-201,620-639`                                             |
| 2   | Recursive stored-revision aliases and shape normalization      | **REIMPLEMENT** | `apps/core/src/config/settings/runtime-settings-compact.ts:27-110,217-248,294-314`                                                                                                      |
| 3   | Provider secret refs repaired during revision reads            | **REIMPLEMENT** | `apps/core/src/config/settings/settings-import-service.ts:543-602`                                                                                                                      |
| 4   | Workflow rewrites the Terraform-owned ECS task definition      | **REIMPLEMENT** | `.github/workflows/gantry_dev_deployment.yml:16,51-73`; `ops/terraform/envs/ecs/main.tf:12-20`; `ops/terraform/modules/ecs_service_set/main.tf:256-278`                                 |
| 5   | MCP capability drift service and sync API/CLI                  | **REIMPLEMENT** | `apps/core/src/application/mcp/mcp-capability-sync-service.ts:53-128,131-238,274-319`; `apps/core/src/control/server/routes/mcp-servers.ts:219-259`; `apps/core/src/cli/mcp.ts:299-326` |
| 6   | One-off raw third-party MCP tool approvals                     | **REIMPLEMENT** | `apps/core/src/runner/mcp/tools/capabilities.ts:60-88,272-313`; `apps/core/src/jobs/request-permission-review.ts:248-275`; `apps/core/src/jobs/ipc-mcp-tool-handlers.ts:458-475`        |
| 7   | Scheduler tools become selectable durable exact grants         | **REIMPLEMENT** | `apps/core/src/shared/admin-mcp-tools.ts:13-33,53-70`; `apps/core/src/runner/gantry-mcp-tool-surface.ts:68-90,118-121,155-198`                                                          |
| 8   | New Slack settings-to-route seed helper                        | **REIMPLEMENT** | `apps/core/src/cli/slack-registration.ts:4-80`                                                                                                                                          |
| 9   | IPC route/field compatibility and ambiguity recovery           | **REIMPLEMENT** | `apps/core/src/runtime/ipc-route-authorization.ts:15-108`; `apps/core/src/runtime/ipc-parsing.ts:392-410,542-560,657-674`                                                               |
| 10  | Provider-account identity propagated in runner messages        | **KEEP**        | `apps/core/src/runner/mcp/tools/messaging.ts:461-470`                                                                                                                                   |
| 11  | Pending-message recovery cursor capped by a hidden age default | **REIMPLEMENT** | `apps/core/src/config/index.ts:486-492`; `apps/core/src/app/bootstrap/runtime-app.ts:444-455`                                                                                           |
| 12  | Unique Slack question action IDs                               | **SIMPLIFY**    | `apps/core/src/channels/slack/channel-state.ts:243`; `apps/core/src/channels/slack/user-question-interactions.ts:32`                                                                    |
| 13  | Slack bot-mention trigger normalization                        | **SIMPLIFY**    | `apps/core/src/channels/slack/channel-message-ingest.ts:32-50,166-180`                                                                                                                  |
| 14  | Slack approval delivery-failure notices                        | **KEEP**        | `apps/core/src/channels/slack/permission-approval-delivery.ts:116-137,159-205`                                                                                                          |
| 15  | Scheduled-job scoring/raw-tool-call summary cleanup            | **REIMPLEMENT** | `apps/core/src/jobs/status-formatting.ts:68-99`                                                                                                                                         |
| 16  | Remote HTTP/SSE MCP CLI registration                           | **KEEP**        | `apps/core/src/cli/mcp.ts:7-8,31-34,175-224`                                                                                                                                            |

Supporting tests, contracts, OpenAPI, catalog seeds, prompt text, access views,
and audit enum edits inherit the verdict of the production group they support;
they are not independent architecture changes.

## Detailed review

### 1. KEEP — latest-revision/CAS settings mutations

The persistent grant add/remove paths now load the latest revision, mutate that
typed state, and carry its revision as the expected CAS value
(`apps/core/src/config/settings/restart-sync.ts:179-205,308-334,361-380`). The
import path checks `expectedRevision` before append and compares the previous
semantic document with the latest revision
(`apps/core/src/config/settings/settings-import-service.ts:174-201`). This
correctly makes `settings_revisions` the authority instead of treating a stale
YAML snapshot as an equal writer.

The canonical comparison is also appropriately fail-closed: it re-renders a
parseable revision, but returns the raw document if parsing fails
(`apps/core/src/config/settings/settings-import-service.ts:620-639`). Retain
commits `13f199676` and `29863909a`, while making their parser consume only the
post-ponytail canonical revision shape. This group prevents, rather than
introduces, the same-fact-twice and mutation-order bug families listed at
`docs/architecture/goals-index.md:17-20`.

### 2. REIMPLEMENT — stored revision aliases

`normalizeStoredRevisionAliases` applies one global key map recursively at
every nesting level
(`apps/core/src/config/settings/runtime-settings-compact.ts:27-110`). It is not
a bounded codec for one historical schema. The same token
is renamed regardless of owning object, and when canonical and alias keys both
exist the alias is silently discarded (`:103-108`). The subsequent normalizer
also deletes `folder`, moves top-level agent sources/capabilities into `access`,
and accepts multiple job/conversation spellings (`:135-159,217-248,264-289`).
That can collapse non-equivalent input without reporting which value lost.

This introduces both a transition shim and a consolidation-fidelity/type-system
lie: the persisted revision is presented as canonical even when the reader has
silently invented its meaning. It directly conflicts with the approved reset/
restamp plan and no-shim decision
(`docs/architecture/ponytail-audit-2026-07-16.md:5-8,45-47`).

Correct implementation: delete `STORED_REVISION_KEY_ALIASES`,
`normalizeStoredRevisionAliases`, and the alias-specific tests. Parse exactly
the canonical revision schema and fail with the precise unsupported path. For
the one preserved local machine, write one canonical revision during the
ponytail restamp; reset other pre-user environments. Do not migrate shapes on
every read.

### 3. REIMPLEMENT — provider secret repair on read

`settingsFromRevisionDocument` now passes every revision through
`repairLegacyProviderAccountSecretRefs`
(`apps/core/src/config/settings/settings-import-service.ts:543-550`). That
reader fabricates Slack, Discord, Teams, and Telegram env refs from a hardcoded
provider table when the durable revision omitted them (`:552-600`). The read
therefore returns authority that is absent from the authoritative document, and
a later ordinary write can persist the invented values.

This is same-fact-twice plus a deployment-blind generated default: the revision
says one thing while the reader supplies environment-specific credentials. The
repo's observed family is explicitly called out at
`docs/architecture/goals-index.md:17-20`.

Correct implementation: delete the repair function/table. Correct the desired
state through the existing revision-first service, with an explicit CAS and
exact `runtime_secret_refs`, or include that correction in the approved local
restamp. An invalid active provider account should fail validation loudly; it
must not acquire credentials because of its provider name.

### 4. REIMPLEMENT — ECS task-definition normalization in GitHub Actions

The workflow hardcodes an account/region-specific SSM ARN and rewrites a live
task definition to remove security options, force privileged mode, enable init,
and inject the secret (`.github/workflows/gantry_dev_deployment.yml:16,51-73`).
Those facts already have a Terraform authority: additional runtime secrets are
composed in `ops/terraform/envs/ecs/main.tf:12-20`, task secrets are emitted at
`ops/terraform/modules/ecs_service_set/main.tf:256-264`, and privileged/init are
set at `:275-278`. The variable and example already support the exact extra
secret (`ops/terraform/envs/ecs/variables.tf:63-70` and
`ops/terraform/envs/ecs/ecs.tfvars.example:25-29`).

The workflow is therefore a second task-definition authority with a different
lifecycle. It also bakes one deployment's ARN into repository code. Revert the
normalization step and configure `CAW_ATS_MCP_AUTHORIZATION` through the dev
Terraform/environment inputs. The deploy workflow should change only the image
of the task definition produced by infrastructure authority. Reimplement commit
`7a1aeeaa8` rather than amending the duplicate.

### 5. REIMPLEMENT — MCP capability sync service

The new service first reads live MCP inventory and the selected capability
(`apps/core/src/application/mcp/mcp-capability-sync-service.ts:66-128,
:140-175`). It treats `source.allowedToolPatterns` as the review boundary, then
copies every currently visible match into exact `implementationBindings`
(`:177-220`). Finally it overwrites the same catalog row in place and records an
audit event (`:274-319`). Thus the same permission is stored twice: once as a
reviewed pattern and again as an inventory-time exact list. The two copies have
different lifecycles, and an agent-specific diagnosis mutates a global selected
capability without creating a reviewed version or updating settings authority.

The endpoint, CLI command, contracts/OpenAPI schemas, audit enum, and 700+
lines of service/route tests all exist only to operate that duplicate
(`apps/core/src/control/server/routes/mcp-servers.ts:219-259`;
`apps/core/src/cli/mcp.ts:299-326`). This is the dominant same-fact-twice family
from `docs/architecture/goals-index.md:17-23` and is outside the four locked MCP
decisions
(`docs/architecture/mcp-skill-acquisition-alignment-goal-prompt.md:44-62`).

Correct implementation: make the selected semantic capability definition the
only action authority. Replace exact discovered copies with a typed reviewed
MCP pattern binding in `apps/core/src/shared/semantic-capabilities.ts`, and have
`apps/core/src/application/agents/agent-tool-runtime-rules.ts:198-214` plus
`apps/core/src/application/mcp/mcp-tool-proxy-capabilities.ts:60-75` enforce the
pattern against the requested `mcp__server__tool` at projection/call time.
Inventory remains inventory and can change without mutating authority. Delete
the sync service, sync route, sync CLI command, sync contracts/OpenAPI/audit
event, and their tests; restore the pre-existing doctor diagnostics locally.
Then implement the separately locked `mcp_search_tools` search surface over
inventory, not over authority
(`docs/architecture/mcp-skill-acquisition-alignment-goal-prompt.md:46-50`).

### 6. REIMPLEMENT — one-off exact third-party MCP grants

The PR expands `request_access target.kind=tool` to raw third-party names
(`apps/core/src/runner/mcp/tools/capabilities.ts:60-88`), forcibly marks them
temporary (`:272-313`), turns the approval into a live exact rule
(`apps/core/src/jobs/request-permission-review.ts:248-275`), and instructs the
agent to use this path when a capability binding is stale
(`apps/core/src/jobs/ipc-mcp-tool-handlers.ts:458-475`).

That is a second authorization model created specifically to bypass drift in
the first one. It violates the locked model that MCP binding is inventory-only
and action requires a reviewed capability
(`docs/architecture/mcp-skill-acquisition-alignment-goal-prompt.md:8-14,
:66-70`). Making the fork transient reduces duration; it does not restore a
single authority or the curated read/write boundary.

Correct implementation: delete the third-party branch from `ExactToolTarget`,
`submitExactToolRequest`, transient-rule creation, proxy recovery text, and
their tests/docs. Once group 5 enforces the selected reviewed pattern directly,
newly discovered matching tools work without a stale exact list. A denial
outside that pattern must identify the reviewed capability that is missing (or
tell an admin to revise it); it must never offer raw-tool approval. Reimplement
commits `59ad050b2`, `5683461be`, `cc9a59e5a`, `3b51c8fb6`, `beccdabea`, and
`4a7d88c12` as that one root fix.

### 7. REIMPLEMENT — scheduler tools as durable exact grants

The PR widens `DurableExactGantryMcpToolName` from admin tools to fourteen
scheduler operations (`apps/core/src/shared/admin-mcp-tools.ts:13-33,53-70`),
then threads that vocabulary through catalog seeds, access documents, job
preflight, CLI display, recovery guidance, and persistent validation
(`apps/core/src/adapters/storage/postgres/seeds.ts:369-411`;
`apps/core/src/application/agents/agent-capability-administration-service.ts:192,327`;
`apps/core/src/application/jobs/job-tool-access-requirements.ts:197-205`;
`apps/core/src/shared/durable-access-policy.ts:167`). But the runner still
classifies scheduler tools as both optional and default:
`OPTIONAL_GANTRY_MCP_TOOL_NAMES` is the scheduler list, while
`DEFAULT_GANTRY_MCP_TOOL_NAMES` includes every optional tool
(`apps/core/src/runner/gantry-mcp-tool-surface.ts:68-90,118-121`). Selection
starts from that default set, so a full agent receives scheduler tools whether
or not a durable selection exists (`:155-188`); locked mode removes them even
if selected (`:190-197`).

The management type claims selection controls access while runtime says preset
controls it. That is a type-system lie and two authorities for the same fact.
Do not keep the 14 catalog rows and generalized “durable exact Gantry MCP”
framework merely to display a selection that runtime ignores.

Correct implementation: retain the existing default/preset-owned scheduler
surface and revert commit `3c92d3f50`, unless product explicitly decides that
scheduling is gated. If it is gated, make one reviewed semantic Scheduling
capability authoritative, remove scheduler tools from the default set, and
derive the mounted operation set from that capability in one place. Do not make
fourteen independently selectable exact capabilities.

### 8. REIMPLEMENT — orphan Slack route seed

`configuredSlackRouteSeed` introduces an 80-line, Slack-named route derivation
over `providerConnections`, `bindings`, and conversation aliases
(`apps/core/src/cli/slack-registration.ts:4-80`). The final branch has no importer
or caller for the exported function (branch-wide `git grep` finds only its
definition), so it is already orphaned. Worse, its input authority is a shape
the same PR rejects as unsupported in the settings reader
(`apps/core/src/config/settings/runtime-settings-compact.ts:301-305`).

Delete the file and commit `d73d978fe`; do not reconnect it. Slack setup should
call the application desired-state/provider-conversation use case, which then
projects the canonical live route. That is the already-selected ownership path
at `docs/architecture/ponytail-audit-2026-07-16.md:481-503,568-575`, not another
CLI route decoder.

### 9. REIMPLEMENT — IPC route and target-field compatibility

The resolver now contains three successive attempts to choose among divergent
route identities (`apps/core/src/runtime/ipc-route-authorization.ts:37-89`).
Its own comments name the inputs “stale duplicate aliases” (`:45-49`), yet the
fix institutionalizes those duplicates instead of rejecting/repairing their
writer. The parser also accepts both top-level `targetJid` and `chatJid` for
permission, question, and rich-interaction IPC, with mismatch logic repeated at
three sites (`apps/core/src/runtime/ipc-parsing.ts:392-410,542-560,657-674`).

This is symptom repair at readers and a transition shim, directly overlapping
the canonical route cut. The approved replacement is to canonicalize every
writer, atomically rebuild cursor state, and retain only qualified route keys
(`docs/architecture/ponytail-audit-2026-07-16.md:142-153`); AR2 requires one
application-owned projection keyed by canonical identities
(`docs/architecture/ponytail-audit-2026-07-16.md:520-540`).

Correct implementation: do not transplant commits `55d9adcf5` or
`0ec4dda44` over ponytail Phase 3. Rebase onto that cut, use its canonical
provider-account-qualified route lookup, and fail closed on a missing/ambiguous
route. Pick one signed IPC destination field, update all writers and readers in
the same change, and delete alternate-field fallback tests. No legacy-route
preference belongs in the new projection.

### 10. KEEP — provider account in runner message IPC

The `send_message` writer now includes the current run's `providerAccountId`
beside `chatJid` (`apps/core/src/runner/mcp/tools/messaging.ts:461-470`). This
adds canonical disambiguating identity at the producer and is exactly the kind
of writer correction AR2 requires. Retain this one hunk from `55d9adcf5`,
adjusted to the post-ponytail IPC envelope; do not retain that commit's route
alias readers.

### 11. REIMPLEMENT — recovery cursor age cap

The PR adds an environment-only 15-minute default
(`apps/core/src/config/index.ts:486-492`) and advances an old recovered bot
cursor to `now - maxAge` with a maximal tie-break ID
(`apps/core/src/app/bootstrap/runtime-app.ts:444-455`). That silently declares
older durable inbound messages processed even though they were never read. The
default is not in `settings.yaml`, desired-state revisions, or a documented
retention policy, so behavior changes by deployment environment without a
canonical setting.

This is data loss disguised as liveness and a deployment-blind default. Revert
the cap and recover from the durable bot cursor. If product wants a message
retention boundary, design it explicitly under runtime settings, document the
dropped-message outcome, and apply it at message persistence/retention—not by
forging a later processing cursor.

### 12. SIMPLIFY — Slack question action IDs

Unique `action_id` values per option are the right minimal fix
(`apps/core/src/channels/slack/channel-state.ts:243`). The handler, however,
accepts both the new indexed IDs and the old unindexed ID through an optional
regex suffix (`apps/core/src/channels/slack/user-question-interactions.ts:32`).
That is an unnecessary transition shim in a pre-user product.

Keep commit `dfcb2c245` but change the handler to
`/^gantry_userq_select_\d+$/` and delete old-ID test cases. No other abstraction
is needed.

### 13. SIMPLIFY — Slack mention normalization

Escaping the Slack bot ID before building a regex is correct
(`apps/core/src/channels/slack/channel-message-ingest.ts:32-42`). The new helper
then removes every bot mention anywhere in the message, trims it, and collapses
all whitespace before prepending a trigger (`:40-50`). That changes legitimate
message content beyond the leading invocation and creates a
consolidation-fidelity loss at the adapter boundary.

Use one anchored, escaped pattern for the leading mention plus optional comma/
colon and following spaces. Replace only that prefix with the canonical route
trigger and preserve the rest of the text byte-for-byte. For multi-route
selection, use the same leading-prefix helper instead of a separate regex
(`:166-180`).

### 14. KEEP — Slack approval delivery-failure notices

The change deduplicates configured approvers and reports the no-approver case
before binding a provider callback
(`apps/core/src/channels/slack/permission-approval-delivery.ts:116-137,
:159-166`). When both block layouts fail or Slack returns no message ID, it
posts a concise conversation/thread notice and still fails closed (`:184-205`).
This does not create permission authority or report delivery as approval; the
Slack adapter is the correct owner for Slack delivery mechanics.

Keep the Slack notice hunk from `7b2d63d15`. Do not generalize it into a
cross-channel service until another adapter needs the identical operation.

### 15. REIMPLEMENT — job summary cleanup

Recognizing `Scoring Summary` as a terminal report marker is a small correct
change (`apps/core/src/jobs/status-formatting.ts:68-89`). The raw-tool-call fix
is in the wrong layer: two broad, multiline regexes strip XML-like output after
it has already entered the job summary (`:92-99`). That patches one consumer and
can delete user-authored text that happens to match the markup.

User-visible text is already normalized at provider boundaries: DeepAgents
accepts only content parts with `type === 'text'`
(`apps/core/src/adapters/llm/deepagents-langchain/runner/stream-normalizer.ts:289-323`),
and the Anthropic runner emits only `text_delta`
(`apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts:581-610`).
Fix whichever adapter/event path is admitting raw tool-call frames,
then keep only the scoring-marker additions in status formatting. Reimplement
commit `38c4bc13c`; do not add more downstream prefix/markup filters.

### 16. KEEP — remote MCP CLI registration

The CLI adds `http`/`sse` and `--url`, requires URL only for remote transports,
and preserves template/sandbox requirements only for stdio
(`apps/core/src/cli/mcp.ts:7-8,175-224`). It continues to call the existing
Control API create/bind use cases rather than constructing a second MCP writer
(`:70-115`). That is a narrow adapter completion and leaves policy/DNS-pinned
validation with the application/runtime path.

Keep the remote-transport and Slack-notice hunks of `7b2d63d15`. When applying
selectively, omit the inherited `sync-capability` usage/dispatch/function at
`apps/core/src/cli/mcp.ts:37,56-59,299-326`, because that surface belongs to
reimplemented group 5.

## Selective integration plan

### Keep/reapply

- `13f199676` — canonical guarded-write comparison, after deleting the new
  compatibility/secret-repair readers it calls.
- `29863909a` — latest-revision mutation base plus expected-revision CAS.
- `7b2d63d15` — only the remote HTTP/SSE registration and Slack delivery-notice
  hunks; omit `sync-capability` context.
- `dfcb2c245` — unique action IDs, with the one-line legacy regex removed.
- `apps/core/src/runner/mcp/tools/messaging.ts:466` from `55d9adcf5` — preserve
  provider-account identity in the post-AR2 IPC envelope.
- The `Scoring Summary` marker additions at
  `apps/core/src/jobs/status-formatting.ts:73-80`, after provider-boundary output
  cleanup is implemented.

### Reimplement or delete

- Revert `7a1aeeaa8`; configure the dev secret through Terraform/environment
  inputs only.
- Replace `9f960b869` and `6539e06ed` with one typed reviewed MCP-pattern
  authority and direct runtime enforcement; delete sync API/CLI/contracts/audit.
- Replace `59ad050b2`, `5683461be`, `cc9a59e5a`, `3b51c8fb6`, `beccdabea`, and
  `4a7d88c12` with capability-based recovery only; no raw third-party exact-tool
  approval.
- Revert `3c92d3f50`; keep scheduler surface preset-owned unless a separate
  product decision creates one semantic Scheduling capability.
- Revert `ebf48db1f`, `b975eaaf5`, `1d1231f6e`, `73b24eb25`, and `eac3c559a`;
  canonical restamp/reset replaces compatibility and repair readers.
- Delete the orphan remainder of `d73d978fe`; use the ponytail application
  desired-state/provider-conversation seam.
- Do not transplant the cursor/route/parser portions of `55d9adcf5` or
  `0ec4dda44`; apply the producer identity hunk after the ponytail AR2 cut.
- Reimplement `38c4bc13c` at the provider-output boundary and keep only its
  scoring marker.
- Amend the merge-resolution mention change to the anchored one-prefix form in
  group 13.

This selective path has lower integration cost than amending the stale branch
in place. `main` and `origin/develop` merge at `e803e21fa`, while the current
ponytail branch already contains canonical routing and contract-authority
commits. Carrying the PR's alias readers into that tree would first create
conflicts and then delete the conflicted code. Rebase/reconstruct the retained
hunks on the ponytail authority cuts, then implement the remaining locked MCP
alignment decisions on `develop`, as the goal prompt requires
(`docs/architecture/mcp-skill-acquisition-alignment-goal-prompt.md:92-101`).

## Bug-family accounting

- **Same fact twice with different lifecycles:** introduced by MCP pattern plus
  synced exact bindings (group 5), raw exact-tool bypass authority (group 6),
  scheduler selection plus default mounting (group 7), and workflow plus
  Terraform task-definition ownership (group 4).
- **Mutation-before-authorization / delivery confused with commit:** not
  introduced by the retained Slack notice; it reports failure and returns
  unapproved
  (`apps/core/src/channels/slack/permission-approval-delivery.ts:159-205`). The
  capability sync is nevertheless an authority mutation from inventory and
  must be removed
  (`apps/core/src/application/mcp/mcp-capability-sync-service.ts:200-220,274-300`).
- **Consolidation fidelity loss:** introduced by recursive revision alias
  normalization (group 2), stale-route preference (group 9), and global Slack
  mention/whitespace rewriting (group 13).
- **Defaults blind to deployment:** introduced by reader-invented provider env
  refs (group 3), the hardcoded dev secret/task rewrite (group 4), and the hidden
  15-minute cursor cap (group 11).
- **Type-system lies:** introduced when scheduler selections are presented as
  access control despite default mounting (group 7), and when noncanonical
  revision shapes are accepted and silently collapsed into typed settings
  (group 2).

These are the exact families the goals index requires closeouts to classify
(`docs/architecture/goals-index.md:13-27`).

## Verification performed

- Fetched the requested ref with `git fetch origin develop` and reviewed
  `git diff main...origin/develop` at `7b2d63d15`.
- Read the mandatory repository documents plus the three architecture standards
  named in the request.
- Used `rg`, `git grep`, direct branch-file reads, commit history, and `ccc`
  semantic search to trace authority, callers, writers, and ponytail overlap.
- Confirmed `configuredSlackRouteSeed` has no caller/importer outside its own
  new file.
- Did not run implementation tests: this is a read-only architecture review and
  the only authorized write is this report.
