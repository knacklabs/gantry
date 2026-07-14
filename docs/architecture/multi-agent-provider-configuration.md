# Multi-Agent Provider Configuration

This document describes the operator-facing contract for configuring multiple
Gantry agents across Slack, Teams, Telegram, Discord, and App/Web
conversations. Provider adapters own native delivery details; Gantry owns
agents, Provider Accounts, Conversation Installs, permissions, sessions, and
runtime routing.

## Mental Model

- A Provider is the channel family: `slack`, `teams`, `telegram`, `discord`, or
  `app`.
- A Provider Account is one native provider identity owned by exactly one
  Gantry agent.
- A Conversation is one provider chat surface: Slack channel/DM, Teams
  channel/chat, Telegram group/DM, Discord channel/thread, or App/Web
  conversation.
- An Agent owns identity, model/persona defaults, attached sources, and
  selected capabilities.
- A Conversation Install means an agent's Provider Account is installed in a
  conversation or thread.

The product rule is simple: connect a Provider Account for an agent, then
install that agent in provider conversations. Multiple agents can share one
conversation when each has its own Provider Account. Users select agents through
provider-native identity, such as mentioning or DMing the actual bot/account,
not through Gantry text selectors.

## Configure Provider Accounts

Secrets are referenced by `runtime_secret_refs`; raw provider tokens do not
belong in `settings.yaml`, desired-state JSON, logs, prompts, docs examples, or
agent-visible context.

```yaml
provider_accounts:
  'provider_account:slack:ops':
    provider: 'slack'
    agent: 'ops'
    label: 'Ops Slack Bot'
    external_identity_ref:
      team_id: 'T0123456789'
      bot_user_id: 'UOPS123'
      app_id: 'AOPS123'
    runtime_secret_refs:
      bot_token: 'gantry-secret:SLACK_OPS_BOT_TOKEN'
      signing_secret: 'gantry-secret:SLACK_OPS_SIGNING_SECRET'

  'provider_account:slack:triage':
    provider: 'slack'
    agent: 'triage'
    label: 'Triage Slack Bot'
    external_identity_ref:
      team_id: 'T0123456789'
      bot_user_id: 'UTRIAGE123'
      app_id: 'ATRIAGE123'
    runtime_secret_refs:
      bot_token: 'gantry-secret:SLACK_TRIAGE_BOT_TOKEN'
      signing_secret: 'gantry-secret:SLACK_TRIAGE_SIGNING_SECRET'

  'provider_account:app:ops':
    provider: 'app'
    agent: 'ops'
    label: 'Ops App Account'
    virtual: true
```

Provider-specific discovery is setup-only. Slack discovery can list allowed
conversations and search locally after pagination. Teams discovery can use
Microsoft Graph for setup, but live messaging still requires the Teams bot
transport. Telegram membership checks depend on Bot API capabilities and bot
admin limits. Discord uses bot/application identity and keeps threads as
conversation surfaces.

## Create Agents

Use agents for permission variation. Do not model permission differences as
provider-specific channel settings.

```yaml
agents:
  ops:
    name: 'Ops'
    model: 'opus'
    agent_harness: 'auto'
    access:
      selections:
        - id: 'mcp__gantry__send_message'
          version: '1'

  triage:
    name: 'Triage'
    persona: 'operator'
    model: 'sonnet'
    agent_harness: 'auto'
    access:
      preset: locked
      selections:
        - id: 'browser.use'
          version: '1'
```

Profile files such as `AGENTS.md` and `SOUL.md` are agent profile state. Agents
request profile changes through the reviewed agent-profile update flow; they do
not edit profile files, provider config, or `settings.yaml` directly.

## Install Agents In Conversations

Conversation policy belongs on the conversation. Agent presence belongs in
conversation installs.

```yaml
conversations:
  'conversation:slack:ops':
    provider: 'slack'
    id: 'C0123456789'
    type: 'channel'
    display_name: '#ops'
    sender_policy:
      allow: '*'
      mode: 'all'
    control_approvers: ['slack:U123', 'slack:U456']

conversation_installs:
  'conversation_install:slack:ops:ops':
    agent: 'ops'
    provider_account: 'provider_account:slack:ops'
    conversation: 'conversation:slack:ops'
    status: 'active'
    memory_scope: 'conversation'

  'conversation_install:slack:ops:triage':
    agent: 'triage'
    provider_account: 'provider_account:slack:triage'
    conversation: 'conversation:slack:ops'
    status: 'active'
    memory_scope: 'conversation'
```

The same shape works for Teams, Telegram, Discord, and App/Web conversations.
Threads and topics remain provider conversation metadata. Slack threads, Teams
reply chains, Telegram forum topics, and Discord threads inherit the parent
conversation's approvers unless a future product flow explicitly narrows them.
Runtime queue keys may include agent and Provider Account ids, but those keys
are not provider addresses and must not appear in public setup UX.

## CLI, API, And Agent Tool Usage

All admin surfaces should converge on the same desired-state services:

- CLI setup/onboarding writes `settings.yaml`, appends a settings revision, and
  reconciles runtime projection.
- Control API Provider Account and Conversation Install endpoints write the
  same desired state for owner/admin automation.
- Gantry MCP admin tools are for reviewed agent-requested changes and require
  selected admin capabilities.

The operator flow should be:

1. Connect a Provider Account for an agent.
2. Discover or register provider conversations.
3. Install the agent's Provider Account in conversations.
4. Verify the provider-native bot/account identity responds.

Expected CLI vocabulary:

```bash
gantry provider account connect slack --agent ops
gantry provider account list
gantry provider account rotate-secret provider_account:slack:ops
gantry conversation install --agent ops --provider-account provider_account:slack:ops --conversation conversation:slack:ops
gantry conversation installs list
```

Agents should use Gantry tools such as `request_access`,
`request_agent_profile_update`, and `request_settings_update` when they need
reviewed changes. They should not instruct users to edit raw provider config or
bypass the approval/capability lifecycle.

## Runtime Guarantees

- One Provider Account starts one provider adapter.
- A provider event never falls back from one Provider Account to another.
- Sessions, cursors, live turn ownership, approvals, delivery, and tool grants
  are isolated by app, agent, Provider Account, conversation, and thread.
- Disabled agents, Provider Accounts, or Conversation Installs fail closed with
  visible setup/action state.
- Provider delivery remains conversation/thread scoped and uses the installed
  Provider Account's secret refs.
- External ingress and scheduler routes target `agentId` or
  `providerAccountId` explicitly when a provider conversation contains more
  than one installed agent.

## Operational Checks

After changing Provider Account or Conversation Install state, use the smallest
checks that prove the surface changed:

```bash
gantry status
gantry settings export --file /tmp/gantry-settings.yaml
gantry provider account list
gantry conversation installs list
gantry agents list
```

Then send provider messages that exercise each native account identity. In one
Slack channel, mentioning the Ops bot and the Triage bot should admit different
agents with different capability sets.
