import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';

export const channelAccountQueryKeys = {
  all: ['channel-accounts'] as const,
};

export type ChannelProvider = {
  id: string;
  displayName: string;
  capabilities: string[];
  credentialKeys: string[];
  status: 'available' | 'setup_only' | 'unavailable';
};

export type ChannelAccount = {
  id: string;
  agentId: string;
  providerId: string;
  label: string;
  status: 'active' | 'disabled';
  credentialKeys: string[];
  createdAt: string;
  updatedAt: string;
};

export type ChannelConversation = {
  id: string;
  providerAccountId: string;
  kind: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function channelProvidersQuery() {
  return queryOptions({
    queryKey: [...channelAccountQueryKeys.all, 'providers'] as const,
    queryFn: async (): Promise<{ providers: ChannelProvider[] }> => {
      const response = await browserFetch('/ui/api/channel-providers', {
        credentials: 'same-origin',
      });
      if (!response.ok)
        throw new Error('Channel providers could not be loaded.');
      return response.json() as Promise<{ providers: ChannelProvider[] }>;
    },
  });
}

export function channelAccountsQuery() {
  return queryOptions({
    queryKey: [...channelAccountQueryKeys.all, 'list'] as const,
    queryFn: async (): Promise<{ accounts: ChannelAccount[] }> => {
      const response = await browserFetch('/ui/api/channel-accounts', {
        credentials: 'same-origin',
      });
      if (!response.ok)
        throw new Error('Channel accounts could not be loaded.');
      return response.json() as Promise<{ accounts: ChannelAccount[] }>;
    },
  });
}

export function channelConversationsQuery() {
  return queryOptions({
    queryKey: [...channelAccountQueryKeys.all, 'conversations'] as const,
    queryFn: async (): Promise<{ conversations: ChannelConversation[] }> => {
      const response = await browserFetch('/ui/api/conversations', {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Conversations could not be loaded.');
      return response.json() as Promise<{
        conversations: ChannelConversation[];
      }>;
    },
  });
}

export function agentConversationInstallsQuery(agentId: string) {
  return queryOptions({
    queryKey: [...channelAccountQueryKeys.all, 'installs', agentId] as const,
    enabled: Boolean(agentId),
    queryFn: async (): Promise<{
      installs: Array<{
        id: string;
        providerAccountId: string;
        conversationId: string;
        threadId: string | null;
        displayName: string;
        status: string;
        memoryScope: string;
        createdAt: string;
        updatedAt: string;
      }>;
    }> => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/conversation-installs`,
        { credentials: 'same-origin' },
      );
      if (!response.ok)
        throw new Error('Conversation installs could not be loaded.');
      return response.json() as Promise<{
        installs: Array<{
          id: string;
          providerAccountId: string;
          conversationId: string;
          threadId: string | null;
          displayName: string;
          status: string;
          memoryScope: string;
          createdAt: string;
          updatedAt: string;
        }>;
      }>;
    },
  });
}
