# MyClaw Channel Providers

## Add A Channel In 5 Minutes

Create a provider file under `apps/core/src/channels/<name>.ts` and export a `ChannelProvider`:

```ts
import type { ChannelProvider } from './provider-registry.js';

export const exampleProvider: ChannelProvider = {
  id: 'example',
  label: 'Example',
  jidPrefix: 'ex:',
  folderPrefix: 'example_',
  isGroupJid: (jid) => jid.startsWith('ex:g:'),
  formatting: 'markdown-native',
  isEnabled: (settings) => settings.channels.example?.enabled ?? false,
  create: () => null,
  setup: {
    envKeys: [],
    describe: () => 'Example channel',
    run: async () => {},
  },
};
```

Register it in `apps/core/src/channels/register-builtins.ts` with `registerChannelProvider(exampleProvider)`.

## Capability Ports

Channels can implement these optional ports based on what the transport supports:

- `StreamingSink`
- `TypingSink`
- `ProgressSink`
- `InteractionSurface`
- `PlanReviewSurface`
- `GroupDiscoverySource`

All ports are structural and opt-in. Implement only what your channel supports.

## Where Provider Id Is Used

A provider `id` becomes:

- `settings.yaml` key under `channels.<id>`
- runtime enablement selector (`settings.channels[id].enabled`)
- sender allowlist key (`settings.channels[id].sender_allowlist`)

A provider `jidPrefix` is used for:

- JID ownership lookup (`providerForJid`)
- registered group summary queries (`jid LIKE '<prefix>%'`)

A provider `folderPrefix` is used for group folder naming conventions.
