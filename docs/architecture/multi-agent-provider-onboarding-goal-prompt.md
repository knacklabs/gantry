# /goal Prompt: Native Multi-Agent Provider Accounts

Use this prompt to pursue the goal:

```text
/goal Implement Native Multi-Agent Provider Accounts from docs/architecture/multi-agent-provider-onboarding-goal-prompt.md.

Mode:
- Single-cut code. No legacy mode, no backward compatibility shim, no migration helper for old local state, and no shared-bot trigger-selector UX.
- Use subagents strictly for implementation. The parent agent may coordinate, inspect, assign scopes, run verification, review, and publish the PR, but must not edit implementation files directly.
- Every implementation subagent must use the ponytail skill in full mode: smallest correct diff, delete stale paths, no speculative abstractions, no wrapper-only files, and one focused check for every non-trivial behavior.
- Subagents must not send progress commentary. Their prompt must say: "No commentary. Return only changed files, tests run, and blockers."
- Parent commentary should stay minimal and factual.

Required skills:
- Parent: grill-me for loophole audits, ponytail for minimal design, product-manager-plan for UX contract, architecture-refactor for clean-cut boundaries, provider-adapter for channel/runtime adapter changes, settings-control-plane for settings/API/CLI projection, schema-change for Postgres changes, permission-safety for approval/secret boundaries, runtime-ops-verification for build/restart/job smoke, and autoreview for closeout.
- Subagents: ponytail always. Add only the one domain skill matching the assigned scope, such as schema-change, provider-adapter, settings-control-plane, permission-safety, or architecture-refactor.

Product contract:
- Public concept is Provider Account.
- A Provider Account is one native Slack/Teams/Telegram/Discord/App identity owned by exactly one Gantry agent.
- Users connect a Provider Account for an agent, then install that agent in provider conversations.
- Users never see or manage an "internal binding", "default connection", route key, or text trigger selector.
- Slack/Teams/Telegram/Discord selection uses the provider-native identity: users mention, DM, invite, or interact with the actual bot/account for that agent.
- Multiple agents in one provider conversation are allowed by installing multiple Provider Accounts there.
- Replies must make the responding provider identity obvious through the provider-native sender, not through host-added text labels.
- App/Web uses the same account-qualified model with a virtual Provider Account and no external channel secret.

Secret strategy:
- Raw provider tokens and app secrets never go in settings.yaml, desired-state JSON, logs, prompts, conversations, installs, or agent profile files.
- Store only runtimeSecretRefs on the Provider Account.
- Actual secret values resolve through RuntimeSecretProvider: gantry-secret:<NAME>, env:<NAME>, or aws-sm:<NAME>.
- Guided CLI setup stores pasted provider secrets as encrypted gantry-secret refs by default.
- API accepts only refs and rejects raw-looking secret values.
- Runtime adapters resolve provider credentials from the exact providerAccountId handling the event or send.
- Delete settings.providers.<provider>.defaultConnection as runtime authority for chat providers.
- Agent tool credentials remain in the agent/capability credential lane; provider account secrets are runtime-owned channel credentials and must never be exposed to the agent runner.

Implementation contract:
1. Rename the active public/domain/runtime concept from ProviderConnection to ProviderAccount.
   - Add agentId ownership to the account.
   - Keep providerId as metadata.
   - Store runtimeSecretRefs on the account.
   - Store provider-native identity evidence in externalIdentityRef/config after validating credentials, for example Slack bot user/app/team ids, Telegram bot id, Teams app/bot identity, or Discord application/bot id.
   - Reject duplicate active accounts for the same provider-native identity.

2. Replace AgentConversationBinding UX and active code with ConversationInstall.
   - ConversationInstall means "this agent's Provider Account is installed in this conversation/thread."
   - Fields must include appId, agentId, providerAccountId, conversationId, optional threadId, status, sender/control policies, memory scope, and timestamps.
   - Remove triggerPattern/requiresTrigger as multi-agent selection authority.
   - Keep slash/session command parsing only where it is actually a command parser, not as provider-account routing.

3. Settings desired state.
   - Replace provider_connections with provider_accounts.
   - Replace bindings with conversation installs or conversation-local installed_agents.
   - settings_revisions remains desired-state authority and settings.yaml remains the readable sync copy.
   - CLI, Control API, approved admin tools, import/export, renderer/parser, validation, compact format, and current-state export must all use Provider Account language.
   - Reject stale provider_connections, defaultConnection, and binding fields instead of silently accepting them.

4. Control API and SDK.
   - Replace providerConnections endpoints/client names with providerAccounts.
   - Replace conversationBindings endpoints/client names with conversation installs.
   - API responses must render secret refs only, never resolved values.
   - OpenAPI/docs/examples must use Provider Account and install language.
   - External ingress and scheduler notification APIs must target agentId or providerAccountId explicitly when a provider conversation can contain more than one agent.

5. CLI and setup UX.
   - Add/replace commands around:
     - gantry provider account connect <provider> --agent <agent-id>
     - gantry provider account list
     - gantry provider account rotate-secret <provider-account-id>
     - gantry conversation install --agent <agent-id> --provider-account <id> --conversation <id>
     - gantry conversation installs list
   - Command output must use user-facing terms: Provider Account, Agent, Conversation, Installed, Needs setup.
   - No output should instruct users to use @agent text triggers or internal binding ids.

6. Runtime routing.
   - Start one provider adapter per active Provider Account, not one adapter per provider id.
   - Inbound lease keys, adapter ids, queue keys, session keys, live-turn authority, stop/continue, cursor recovery, outbound delivery, scheduler notifications, approvals, and audit events must carry providerAccountId and agentId.
   - A provider event must never fall back from one provider account to another provider account.
   - A disabled agent, disabled provider account, disabled install, missing secret, missing membership, or ambiguous route must fail closed with a visible setup/action state.

7. Provider adapters.
   - Slack: each Provider Account uses its own Slack app/bot tokens and native bot user identity. app_mention and message events route only for that account. Multiple Slack bots in one channel are supported.
   - Teams: model the same Provider Account contract. Discovery/setup may use Graph where existing code supports it, but live messaging must be through Teams bot identity and fail closed if the bot transport is not configured.
   - Telegram: each Provider Account is one bot token. Membership checks use Bot API primitives and respect bot-admin limitations.
   - Discord: each Provider Account is one bot/application identity. Threads/channels stay conversation surfaces.
   - App/Web: create a virtual Provider Account per agent without external runtime secrets.

8. Security and permissions.
   - Conversation approvers remain conversation-scoped and govern approvals for all installed agents in that conversation.
   - Permission prompts, transient grants, durable capabilities, pending interactions, and audit records must include agentId and providerAccountId.
   - Same-channel approval must verify the provider account, conversation, thread, actor membership, and requesting agent.
   - No provider secret may be projected into tool subprocess env, agent prompts, files, logs, or model SDK env.

9. Cleanup.
   - Delete or replace active references to ProviderConnection, providerConnections, provider_connections, AgentConversationBinding, conversationBindings, defaultConnection, triggerPattern, and requiresTrigger where they are part of multi-agent provider routing/setup.
   - Keep only unrelated command-parser usage if proven by code reading and documented in the final closeout.
   - Remove obsolete tests, docs, SDK examples, OpenAPI schemas, route helpers, and settings branches in the same PR.

Subagent implementation split:
- Subagent A, schema/domain: ProviderAccount and ConversationInstall domain types, repository ports, Postgres schema/migrations, persistence tests.
- Subagent B, settings/control plane: settings parser/renderer/validation/import/export, desired-state service, Control API/OpenAPI/SDK, admin tools.
- Subagent C, runtime routing: channel wiring, queue/session/live-turn/recovery/outbound/scheduler/approval/audit account qualification.
- Subagent D, provider adapters/CLI: Slack/Teams/Telegram/Discord/App account setup, secret ref handling, membership/discovery, CLI commands and status copy.
- Subagent E, tests/docs cleanup: focused tests, docs updates, stale-reference cleanup, final verification evidence. This subagent may edit tests/docs only.

Acceptance criteria:
- A user can create two agents with different permissions and connect separate Slack Provider Accounts for them.
- Both Slack Provider Accounts can be installed in the same Slack channel and reply as separate native Slack bot identities.
- The same model works for Telegram, Discord, Teams, and App/Web at the account/install contract level.
- Provider Account secret refs are resolved per account; no path uses provider-level defaultConnection.
- External ingress and scheduler routes cannot accidentally target the wrong agent in a multi-agent conversation.
- Disabling an agent/account/install stops inbound and outbound behavior for that account without affecting sibling agents.
- Raw provider secrets are absent from settings.yaml, settings_revisions JSON, logs, docs examples, tests, API responses, and agent-visible context.
- Cleanup search proves stale active code paths are gone.

Focused tests:
- Settings parser rejects provider_connections, defaultConnection, bindings, triggerPattern, and raw provider secrets.
- Settings parser accepts two Provider Accounts for two agents installed in one conversation.
- Provider Account validation rejects duplicate provider-native identity.
- Runtime secret lookup requires providerAccountId and resolves different refs for two accounts on the same provider.
- Channel wiring starts one adapter per active Provider Account and lease keys include providerAccountId.
- Inbound Slack event for account A cannot route to account B.
- Outbound delivery uses the installed Provider Account secret refs.
- Permission prompt resolution verifies providerAccountId, agentId, conversation, thread, and approver.
- Disabled account/agent/install fails closed.
- App/Web virtual Provider Account routes without external secrets.
- Cleanup test or static check covers stale route helpers where practical.

Required verification:
- Run focused tests after each subagent slice.
- Run cleanup searches and record every remaining hit:
  - rg "ProviderConnection|providerConnections|provider_connections|AgentConversationBinding|conversationBindings|defaultConnection" apps/core/src docs
  - rg "triggerPattern|requiresTrigger|@agent|internal binding|binding" apps/core/src docs
- Remaining hits must be deleted or justified as unrelated command parsing, historical docs intentionally retained, or generated schema names that are no longer active.
- Run:
  - npm run typecheck
  - npm run lint
  - npm run test:unit
  - npm test
  - npm run build
  - python3 .codex/scripts/check_architecture.py
  - python3 .codex/scripts/verify.py
  - python3 .codex/scripts/validate_artifacts.py --allow-missing-run
  - python3 .codex/scripts/check_task_completion.py

Review loop:
- Run ponytail-review on the final diff. Remove accepted complexity findings unless removing them would weaken the requested UX, security, or provider-neutral behavior.
- Run autoreview:
  - python3 /Users/ravikiranvemula/.codex/skills/autoreview/scripts/autoreview --mode local
- Fix accepted/actionable findings with the smallest diffs.
- Rerun focused tests and autoreview until no accepted/actionable findings remain.

Runtime smoke:
1. Build from this checkout:
   - npm run build
2. Restart local Gantry through launchd:
   - launchctl kickstart -k gui/$(id -u)/com.gantry
3. Confirm runtime state:
   - gantry status
   - launchctl print gui/$(id -u)/com.gantry
4. Run the Knacklabs lead gen job from the current runtime:
   - use scheduler_list_jobs to find the job named "Knacklabs lead gen"
   - use scheduler_run_now with the discovered job id
   - use scheduler_list_runs, scheduler_list_events, or scheduler_wait_for_events for completion evidence
   - do not use raw DB edits, sleep-loop-only proof, or log-only proof

PR closeout:
- Work on the existing branch and update the existing PR, not a new PR.
- Existing branch: codex/multi-agent-provider-onboarding.
- Existing PR: #189.
- Commit only files intentionally changed for this goal.
- Re-check git status after commit hooks.
- Push the branch and update PR #189 with:
  - product summary
  - single-cut/no-legacy note
  - secret-storage strategy
  - provider UX evidence
  - cleanup search results
  - tests/build/verify output
  - launchctl/status evidence
  - Knacklabs lead gen job evidence
  - autoreview result
```

## Locked Strategy

- Store multiple agent provider secrets as runtime secret refs on Provider
  Accounts, not on agents, conversations, provider defaults, or installs.
- Provider Account is the public and code-level term.
- Conversation Install is the user-facing operation: install an agent in a
  provider conversation using that agent's Provider Account.
- Native provider identity is the only chat selector for multi-agent UX.
- Clean cut means stale connection/binding/default-trigger paths are removed,
  not hidden behind compatibility branches.

## Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Adapters, queues, sessions, recovery, approvals, and delivery become provider-account-qualified. |
| `settings.yaml` | Changed | `provider_accounts` and installs replace provider connections and bindings. |
| Postgres/runtime projection | Changed | Provider Account ownership and Conversation Install records replace old active tables/types. |
| Control API | Changed | Provider Account and install endpoints replace connection/binding endpoints. |
| SDK/contracts | Changed | Client names, request/response bodies, and examples use Provider Account language. |
| CLI | Changed | Setup/list/install/rotate/status commands use Provider Account UX. |
| Gantry MCP/admin tools | Changed | Reviewed admin changes target Provider Accounts and installs. |
| Channel/provider adapters | Changed | Slack, Teams, Telegram, Discord, and App/Web instantiate and route per account. |
| Docs/prompts | Changed | This prompt, architecture docs, SDK docs, and operator docs must use the new UX. |
| Audit/events | Changed | Events include providerAccountId and agentId where provider conversations are involved. |
| Tests/verification | Changed | Multi-account/multi-agent routing, secrets, cleanup, build, runtime smoke, and PR evidence are required. |

## Non-Negotiable Rejections

- No internal binding UX.
- No shared Slack bot plus `@agent` text selector.
- No provider-level default account as runtime authority.
- No raw provider secrets in settings, DB JSON, logs, docs examples, or agent context.
- No "temporary" compatibility branch for old settings or old local Postgres rows.
- No provider-specific logic in core runtime when a provider-neutral account/install field solves it.
