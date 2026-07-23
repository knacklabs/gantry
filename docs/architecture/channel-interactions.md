# Conversation Interactions

Gantry renders one conversation-neutral interaction model across Slack,
Telegram, Teams, Web, API sessions, and agent-initiated requests. Provider adapters own
presentation. Application policy owns authorization.

Agents must not choose provider-specific payloads directly. They choose the
right Gantry tool, the host builds an `InteractionDescriptor`, and the provider
adapter renders it using the provider's native controls.

## Conversation Administration Model

Use `Conversation` as the public admin term for Slack channels/DMs, Teams
channels/chats, Telegram groups/DMs, and App/Web conversations. A `Provider`
is Slack, Teams, Telegram, or App/Web. A `Provider Connection` is one installed
workspace, bot, tenant, or app connection. Slack and Teams threads, plus
Telegram forum topics, are `Session` records under a Conversation.

Conversations can bind multiple agents. Routing priority is deterministic:

1. explicit mention or command
2. session default agent
3. conversation default agent
4. picker when the route is ambiguous

Conversation sender policy is a Conversation-owned allowlist. It is displayed
and managed on the Conversation/admin surfaces, separately from Conversation
membership and control approvers. It controls who may send messages into that
conversation, but it does not grant approval rights by itself.

Conversation control approvers decide permission prompts for all agents bound
to the Conversation, must be verified members of that Conversation before save
and again when approving, and never grant agent capabilities by themselves.
Slack, Telegram, Teams, and App/Web conversations must expose the same admin
behavior for direct/private and group/channel conversations: same-conversation
origin check, Conversation approver check, and Conversation sender policy.

Conversation setup should prefer provider discovery and validation. Pasted Slack,
Teams, or Telegram IDs are accepted as a fallback only after Gantry verifies
the bot can see the conversation and post or, for Telegram, that the bot is a member
and forum topics are available when topic sessions are requested.

## InteractionDescriptor

`InteractionDescriptor` is the canonical shape for permission prompts,
capability reviews, structured questions, status cards, final decisions, and
audit summaries.

Fields:

- `title`
- `body`
- `severity`
- `requestContext`
- `options`
- `selectionMode`
- `actions`
- `details`
- `files`
- `dependencies`
- `auditSummary`
- `result`

Permission descriptors keep semantic scope primary. Primary text shows the
capability display name, requester, account/context, what it allows, what it
does not allow, health/preflight status when available, and the valid choices
for the flow. Prompts offer `Allow once`, `Allow for future` when a persistent
suggestion exists, and `Cancel`. Details hold raw
request ids, low-level tool/rule, redacted command preview, command hash,
executable path/version, sandbox/network behavior, and settings/storage
effects.

Descriptors are data, not policy. They can display `send_message`,
`ask_user_question`, `continuity_summary`, `file`, `request_skill_install`,
`request_skill_proposal`, `request_skill_dependency_install`,
`request_mcp_server`, `request_access`, `settings_desired_state`,
`request_settings_update`, `admin_permission_list`,
`admin_permission_revoke`, `service_restart`, and `register_agent` requests,
but approval authority stays with the configured conversation/conversation
approver rules.

## Tool Selection Rules

Use these rules in agent prompts, docs, and admin surfaces:

| User intent                                                    | Tool access requirement                       | Channel behavior                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send progress, status, or a normal message while still running | `send_message`                                | Delivers plain channel text using the active channel formatting dialect.                                                                                                                                                                                                                                                        |
| Ask the user to choose one option                              | `ask_user_question` with `multiSelect: false` | Slack buttons/radio, Telegram inline buttons, Teams action buttons, Web/API single-select control.                                                                                                                                                                                                                              |
| Ask the user to choose multiple options                        | `ask_user_question` with `multiSelect: true`  | Slack checkboxes/multi-select plus Done, Telegram toggle buttons plus Done, Teams `Input.ChoiceSet` plus Done, Web/API multi-select control.                                                                                                                                                                                    |
| Inspect current continuity                                     | `continuity_summary`                          | Returns scoped continuity data for agent reasoning; channels render any human-facing summary only through normal message descriptors.                                                                                                                                                                                           |
| Manage Gantry FileArtifacts                                    | `file`                                        | Uses virtual artifact scopes and compact descriptors; channel adapters never receive host filesystem paths or storage refs as user-facing copy.                                                                                                                                                                                 |
| Install a skill package                                        | `request_skill_install`                       | Renders `SKILL.md` preview, files, dependencies, or an exact installer command such as `npx ... install <skill>` that will run in host-controlled staging and import the produced package, with activation timing and approve/deny.                                                                                             |
| Propose or update agent-created skill files                    | `request_skill_proposal`                      | Renders `SKILL.md` preview, file list, risk summary, and approve/deny. A package matching a selected skill is treated as a complete replacement, labeled as an update, and applied only after a configured conversation approver accepts; the installed content hash is rechecked before mutation.                              |
| Install skill dependencies                                     | `request_skill_dependency_install`            | Renders npm/brew/go/uv/download spec, command argv, sandbox/policy, risk, approve/deny.                                                                                                                                                                                                                                         |
| Add a third-party MCP server                                   | `request_mcp_server`                          | Renders reviewed `stdio_template`, sandbox profile, Gantry Credential refs, allowed tool patterns, approve/deny. Remote HTTP/SSE MCP remains fail-closed until Gantry has DNS-pinned remote transport.                                                                                                                          |
| Request reviewed semantic capability                           | `request_access`                              | Requests an approved semantic capability by id from the Agent Access summary or attached source inventory.                                                                                                                                                                                                                      |
| Request scoped command fallback                                | `request_access`                              | Renders `Allow <access>?` only for scoped `RunCommand` fallback requests when no reviewed capability fits. Broad or exact SDK/native tool grants are not durable authority.                                                                                                                                                     |
| Inspect selected and requestable Gantry capabilities           | Agent Access summary                          | Lists available Gantry tools, reviewed semantic capabilities, selected skills/MCP servers, and unavailable requestable admin capabilities with exact request arguments.                                                                                                                                                         |
| Inspect local desired-state settings                           | `settings_desired_state`                      | Agents with the selected `mcp__gantry__settings_desired_state` tool grant can read rendered `settings.yaml` plus its revision for review context; no write occurs. Unselected agents receive `request_access` guidance.                                                                                                         |
| Change local desired-state settings                            | `request_settings_update`                     | Agents with the selected `mcp__gantry__request_settings_update` tool grant can request a complete replacement `settings.yaml` with the expected revision; the host validates it, shows a diff summary for same-channel approval, rechecks the revision/references after approval, writes atomically, then reloads safe changes. |
| List current-agent persistent admin grants                     | `admin_permission_list`                       | Requires selected `mcp__gantry__admin_permission_list`; reports the requesting agent's persistent Gantry MCP grants without exposing other agents' grants.                                                                                                                                                                      |
| Revoke one current-agent persistent admin grant                | `admin_permission_revoke`                     | Requires selected `mcp__gantry__admin_permission_revoke`; removes one current-agent grant and records the reviewed change.                                                                                                                                                                                                      |
| Restart after approved changes                                 | `service_restart`                             | Requires selected `mcp__gantry__service_restart` tool grant; reports validation and restart status.                                                                                                                                                                                                                             |
| Bind a channel to an agent                                     | `register_agent`                              | Requires selected `mcp__gantry__register_agent` tool grant; validates the channel/session target and creates an agent binding.                                                                                                                                                                                                  |

The agent must never substitute `Bash`, direct config edits, direct SDK calls,
or provider-specific API writes for these request tools.

## Slack

Slack renders descriptors with Block Kit sections, fields, context, dividers,
buttons, radio buttons, checkboxes or multi-selects, and modals when the request
needs more room. Unauthorized approvers receive an ephemeral denial. Approval
cards update in place with the final status.

Slack details:

- Use `mrkdwn` for compact summaries, fields for provider/risk, and context
  blocks for request ids and activation timing.
- Use buttons for approve, deny, details, files, dependencies, and audit.
- Use radio buttons for mutually exclusive choices when labels are short.
- Use checkboxes or `multi_static_select` for multi-select questions.
- Use modals for long `SKILL.md` previews, file lists, MCP tool patterns, and
  dependency output.
- Always `ack()` interactive actions immediately, then update the original
  message.
- Wrong channel or unauthorized user gets an ephemeral denial without leaking
  request secrets.

## Telegram

Telegram renders concise HTML messages plus inline keyboards. Single-select
uses one button per option. Multi-select uses toggle buttons plus `Done`.
Details and files are paginated because callback payloads are small. Wrong
chat, stale nonce, replay, and unauthorized users fail closed.

Telegram details:

- Store interaction state server-side and put only a short signed nonce/action
  id in callback data.
- Render one button per action or option. Keep labels short and stable.
- Multi-select toggles selected state in the message and requires `Done`.
- Split long details into pages. Never put raw file contents or secrets into
  callback data.
- Use answer-callback alerts for unauthorized, stale, timed-out, or replayed
  actions.
- Respect Telegram forum topics by preserving `message_thread_id` as the
  conversation thread.

## Teams

Teams is a first-class channel target in the channel model. Current support
includes Microsoft Graph setup/discovery, `teams:` conversation ids, normalized
inbound/outbound adapter shapes, and Adaptive Card approval scaffolding behind
the `TeamsSdkClient` seam. A concrete live Bot Framework transport is still a
future adapter. Teams renderers use Adaptive Cards and `Action.Execute` for
approvals and prompts. Single-select uses action buttons. Multi-select uses
`Input.ChoiceSet` plus `Done`. Details and files use card updates, show-card
sections, or dialogs where needed. Final decisions update the original card
using Teams activity update. Unauthorized users receive targeted/private
feedback where Teams supports it; otherwise Gantry sends a non-sensitive denial
update.

Teams details:

- Use Adaptive Card `Action.Execute` for approve, deny, select, details, files,
  dependencies, and audit actions.
- Validate Teams control approvers through Microsoft Graph conversation
  membership: `/chats/{chat-id}/members` for chat-style conversation ids, and
  `/teams/{team-id}/channels/{channel-id}/members` when the provider connection
  config includes `teamId` and `channelId`.
- Include tenant id, conversation id, reply chain/thread id, request id, and
  nonce in the server-side interaction record, not as trusted card state.
- Use `Input.ChoiceSet` with `isMultiSelect: true` for multi-select prompts and
  submit through a Done action.
- In Teams channels, assume the bot only sees messages where it is mentioned;
  approval UX should be concise and card-driven.
- Update the original activity after approval/denial so the channel has one
  current source of truth.
- If targeted denial is unavailable, post only a generic denial status and keep
  detailed authorization reasons in audit logs.

## Web And API

Web/API renderers expose the same descriptor as cards, tables, modals, file
browser views, and an audit timeline. API callers must treat descriptors as
rendering contracts; they must not bypass `request_skill_install`,
`request_skill_proposal`, `request_skill_dependency_install`,
`request_mcp_server`, or `request_access` by editing durable state directly.

## Channel Tool Requests

Channel-specific tools are approved capabilities. Examples include Teams
proactive messaging, Slack file access, and Telegram file download behavior.
Agents request them with `request_access target.kind=capability` using the
reviewed semantic capability id for that provider/channel action. A provider
flag describes whether the adapter can render or execute an interaction; it is
not an authorization grant.

Channel tool request payloads must include:

- `provider`: `slack`, `telegram`, `teams`, or `web`.
- `capability`: stable enum such as `slack_file_access`,
  `telegram_file_download`, `teams_proactive_message`, `teams_card_update`, or
  `web_file_browser`.
- `reason`: user-visible reason for the request.
- `conversationScope`: optional channel/conversation/thread ids affected.
- `requiredScopes`: provider scopes or app permissions the admin should verify.
- `risk`: low, medium, or high, derived by the host, not the agent.

Approval binds only the named channel capability for the named agent or channel
scope. It never grants all provider SDK access.
