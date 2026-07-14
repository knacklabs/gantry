import type { RuntimeLease } from '../domain/ports/runtime-lease.js';
import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import type { logger } from '../infrastructure/logging/logger.js';
import type { ChannelAdapter, ChannelOpts } from './channel-provider.js';
import type { Provider } from './provider-registry.js';

interface ProviderAccountRuntimeSettings {
  providerAccounts: Record<
    string,
    {
      provider: string;
      agentId: string;
      status?: 'active' | 'disabled';
      runtimeSecretRefs?: Record<string, string>;
    }
  >;
  runtime: { deploymentMode?: string };
}

export interface BoundProviderAccountChannel {
  channel: ChannelAdapter;
  providerId: string;
  providerAccountId: string;
  inboundProviderAccountIds: string[];
  interactionCallbacks: boolean;
  agentId: string;
}

export async function connectProviderAccountChannels(input: {
  provider: Provider;
  appId: string;
  runtimeSettings: ProviderAccountRuntimeSettings;
  channelOpts: ChannelOpts;
  inboundEnabled: boolean;
  connectedChannels: BoundProviderAccountChannel[];
  connectedChannelLeases: RuntimeLease[];
  inboundLeasePrefix: string;
  logger: Pick<typeof logger, 'info' | 'warn'>;
}): Promise<void> {
  const inboundKeyFor = (account: {
    runtimeSecretRefs?: Record<string, string>;
  }) => {
    const entries = Object.entries(account.runtimeSecretRefs ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    if (entries.length === 0) return undefined;
    return JSON.stringify([input.provider.id, entries]);
  };
  const accounts: Array<
    [
      string,
      {
        provider: string;
        agentId: string;
        status?: 'active' | 'disabled';
        runtimeSecretRefs?: Record<string, string>;
      },
    ]
  > = input.provider.internal
    ? [
        [
          `control:${input.appId}`,
          {
            provider: input.provider.id,
            agentId: 'main_agent',
            runtimeSecretRefs: {},
          },
        ],
      ]
    : Object.entries(input.runtimeSettings.providerAccounts).filter(
        ([, account]) =>
          account.provider === input.provider.id &&
          account.status !== 'disabled',
      );
  const inboundAccountIdsByKey = new Map<string, string[]>();
  for (const [providerAccountId, account] of accounts) {
    const inboundKey = inboundKeyFor(account);
    if (!inboundKey) continue;
    const accountIds = inboundAccountIdsByKey.get(inboundKey) ?? [];
    accountIds.push(providerAccountId);
    inboundAccountIdsByKey.set(inboundKey, accountIds);
  }
  const attemptedInboundKeys = new Set<string>();
  if (accounts.length === 0) {
    input.logger.warn(
      { channel: input.provider.id },
      'Channel enabled but no active Provider Account is configured — skipping connect',
    );
    return;
  }
  for (const [providerAccountId, account] of accounts) {
    const agentId = agentIdForFolder(account.agentId);
    const inboundKey = inboundKeyFor(account);
    const inboundProviderAccountIds =
      inboundKey && inboundAccountIdsByKey.get(inboundKey)?.length
        ? inboundAccountIdsByKey.get(inboundKey)!
        : [providerAccountId];
    const channel = await input.provider.create({
      ...input.channelOpts,
      providerAccountId,
      inboundProviderAccountIds,
      agentId,
      onChatMetadata: (
        conversationJid,
        timestamp,
        name,
        channel,
        isGroup,
        options,
      ) =>
        options?.providerAccountId &&
        options.providerAccountId !== providerAccountId
          ? input.channelOpts.onChatMetadata(
              conversationJid,
              timestamp,
              name,
              channel,
              isGroup,
              options,
            )
          : Promise.all(
              inboundProviderAccountIds.map((targetProviderAccountId) =>
                input.channelOpts.onChatMetadata(
                  conversationJid,
                  timestamp,
                  name,
                  channel,
                  isGroup,
                  {
                    ...options,
                    providerAccountId: targetProviderAccountId,
                  },
                ),
              ),
            ).then(() => undefined),
      onMessage: (chatJid, msg) =>
        msg.providerAccountId
          ? input.channelOpts.onMessage(chatJid, msg)
          : Promise.all(
              inboundProviderAccountIds.map((targetProviderAccountId) =>
                input.channelOpts.onMessage(chatJid, {
                  ...msg,
                  providerAccountId: targetProviderAccountId,
                  agentId: agentIdForFolder(
                    accounts.find(([id]) => id === targetProviderAccountId)?.[1]
                      .agentId ?? agentId,
                  ),
                }),
              ),
            ).then(() => undefined),
    });
    if (!channel) {
      if (
        input.provider.controlCapabilityFlags?.includes('runtime-placeholder')
      ) {
        throw new Error(
          `${input.provider.label} channel runtime transport is not implemented; this provider currently supports setup/discovery only. Disable providers.${input.provider.id}.enabled before starting the runtime.`,
        );
      }
      input.logger.warn(
        { channel: input.provider.id, providerAccountId },
        'Provider Account credentials missing — skipping channel connect',
      );
      continue;
    }

    let providerInbound =
      input.inboundEnabled &&
      (!inboundKey || !attemptedInboundKeys.has(inboundKey));
    let providerInboundLease: RuntimeLease | undefined;
    if (providerInbound && inboundKey) attemptedInboundKeys.add(inboundKey);
    if (
      providerInbound &&
      input.runtimeSettings.runtime.deploymentMode === 'fleet'
    ) {
      providerInboundLease = await input.channelOpts.runtimeLease?.tryAcquire(
        `${input.inboundLeasePrefix}:${input.provider.id}:${providerAccountId}`,
      );
      providerInbound = providerInboundLease !== undefined;
      if (!providerInbound) {
        input.logger.info(
          { channel: input.provider.id, providerAccountId },
          'Provider Account inbound lease held by another worker; connecting channel outbound-only',
        );
      }
    }

    try {
      input.connectedChannels.push({
        channel,
        providerId: input.provider.id,
        providerAccountId,
        inboundProviderAccountIds,
        interactionCallbacks: providerInbound,
        agentId,
      });
      await channel.connect({
        inbound: providerInbound,
        interactionCallbacks: providerInbound,
      });
    } catch (err) {
      await providerInboundLease?.release();
      throw err;
    }
    if (!providerInboundLease) continue;
    input.connectedChannelLeases.push(providerInboundLease);
    providerInboundLease.onLost?.((err) => {
      input.logger.warn(
        { err, channel: input.provider.id, providerAccountId },
        'Provider Account inbound lease lost; disconnecting channel',
      );
      void channel.disconnect().catch((disconnectErr) => {
        input.logger.warn(
          { err: disconnectErr, channel: input.provider.id, providerAccountId },
          'Failed to disconnect channel after provider account inbound lease loss',
        );
      });
    });
  }
}
