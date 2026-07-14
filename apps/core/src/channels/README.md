# Gantry Provider Transport Adapters

This directory is still named `channels` for the transport-adapter layer, but
product and settings code must use the canonical vocabulary:

- **Provider**: Slack, Teams, Telegram, App, or another external network.
- **Provider connection**: one installed workspace, bot, tenant, or app
  connection.
- **Conversation**: a Slack channel/DM, Teams channel/chat, Telegram group/DM,
  or App conversation.
- **Thread/topic**: a provider-native sub-conversation such as a Slack thread,
  Teams reply chain, or Telegram forum topic.

Use `channel` only when the provider API itself uses that word, such as Slack
`conversations.members` parameters or Teams `channelId` fields. Runtime,
settings, API, CLI, approval, and application-service contracts should say
`conversation`, `provider`, or `provider connection`.

## Add A Provider Adapter In 5 Minutes

Create a provider file under `apps/core/src/channels/<name>.ts` and export a
`Provider`:

```ts
import type { Provider } from './provider-registry.js';

export const exampleProvider: Provider = {
  id: 'example',
  label: 'Example',
  jidPrefix: 'ex:',
  folderPrefix: 'example_',
  isGroupJid: (jid) => jid.startsWith('ex:g:'),
  formatting: 'markdown-native',
  isEnabled: (settings) => settings.providers?.example?.enabled ?? false,
  create: () => null,
  setup: {
    envKeys: [],
    describe: () => 'Example provider connection',
    run: async () => {},
  },
};
```

Register it in `apps/core/src/channels/register-builtins.ts` with `registerProvider(exampleProvider)`.

## Capability Ports

Provider adapters can implement these optional ports based on what the transport supports:

- `StreamingSink`
- `TypingSink`
- `ProgressSink`
- `InteractionSurface`
- `PlanReviewSurface`
- `GroupDiscoverySource`

All ports are structural and opt-in. Implement only what the provider transport
supports.

## Where Provider Id Is Used

A provider `id` becomes:

- `settings.yaml` key under `providers.<id>`
- Provider Account records under `provider_accounts.*`
- conversation records under `conversations.*`
- Conversation Install records under `conversation_installs.*`
- conversation approvers on `conversations.<id>.control_approvers`

A provider `jidPrefix` is used for:

- JID ownership lookup (`providerForJid`)
- registered group summary queries (`jid LIKE '<prefix>%'`)

A provider `folderPrefix` is used for current agent workspace folder naming
conventions. Do not expose folder names as product identity in new API,
settings, or application contracts.
