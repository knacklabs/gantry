import { z } from 'zod';

import type { RuntimeApiTransport } from '../../lib/api/runtime-transport';

const providerAccountSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  providerId: z.string(),
  label: z.string(),
  status: z.enum(['active', 'inactive', 'disabled', 'archived']),
});

const conversationSchema = z.object({
  id: z.string(),
  providerAccountId: z.string(),
  kind: z.enum(['dm', 'group', 'channel', 'chat', 'web', 'sdk']),
  title: z.string().nullable().optional(),
  status: z.enum(['active', 'inactive', 'archived']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

const installSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  providerAccountId: z.string(),
  conversationId: z.string(),
  threadId: z.string().nullable().optional(),
  displayName: z.string(),
  status: z.enum(['active', 'disabled']),
  memoryScope: z.enum(['user', 'conversation', 'agent', 'app']),
  routeConfig: z
    .object({
      trigger: z.string().optional(),
      requiresTrigger: z.boolean().optional(),
    })
    .optional(),
});

const threadSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  title: z.string().nullable().optional(),
  status: z.enum(['active', 'inactive', 'archived']),
  updatedAt: z.string(),
});

const messagePartSchema = z.object({
  kind: z.string(),
  payload: z.unknown(),
});

const messageSchema = z.object({
  id: z.string(),
  direction: z.enum(['inbound', 'outbound', 'system', 'tool']),
  senderDisplayName: z.string().nullable().optional(),
  trust: z.enum(['trusted', 'untrusted', 'system', 'redacted']),
  parts: z.array(messagePartSchema),
  createdAt: z.string(),
});

const providerAccountsResponseSchema = z.object({
  providerAccounts: z.array(providerAccountSchema),
});
const conversationsResponseSchema = z.object({
  conversations: z.array(conversationSchema),
});
const agentsResponseSchema = z.object({ agents: z.array(agentSchema) });
const installsResponseSchema = z.object({
  conversationInstalls: z.array(installSchema),
});
const threadsResponseSchema = z.object({ threads: z.array(threadSchema) });
const messagesResponseSchema = z.object({ messages: z.array(messageSchema) });
const approversResponseSchema = z.object({
  approvers: z.object({ userIds: z.array(z.string()) }),
});

export type AgentOption = z.infer<typeof agentSchema>;
export type ConversationInstall = z.infer<typeof installSchema>;
export type ProviderAccountOption = z.infer<typeof providerAccountSchema>;

export type ConversationView = {
  id: string;
  name: string;
  provider: string;
  providerAccountId: string;
  kind: string;
  agent: string;
  agentId?: string;
  status: 'active' | 'inactive' | 'archived';
  updatedAt: string;
};

export type ConversationMessageView = {
  id: string;
  author: string;
  content: string;
  direction: z.infer<typeof messageSchema>['direction'];
  createdAt: string;
};

export type ConversationDashboard = {
  conversations: ConversationView[];
  providerAccounts: ProviderAccountOption[];
  agents: AgentOption[];
  installs: ConversationInstall[];
};

export type ConversationDetail = {
  conversation: ConversationView;
  threads: z.infer<typeof threadSchema>[];
  messages: ConversationMessageView[];
  approverIds: string[];
};

export const conversationQueryKeys = {
  all: ['conversations'] as const,
  dashboard: () => [...conversationQueryKeys.all, 'dashboard'] as const,
  detail: (conversationId: string) =>
    [...conversationQueryKeys.all, 'detail', conversationId] as const,
};

export async function loadConversationDashboard(
  transport: RuntimeApiTransport,
): Promise<ConversationDashboard> {
  const [accounts, conversations, agents] = await Promise.all([
    transport.request({
      path: '/provider-accounts',
      schema: providerAccountsResponseSchema,
    }),
    transport.request({
      path: '/conversations',
      schema: conversationsResponseSchema,
    }),
    transport.request({ path: '/agents', schema: agentsResponseSchema }),
  ]);
  const installLists = await Promise.all(
    agents.agents.map((agent) =>
      transport.request({
        path: `/agents/${encodeURIComponent(agent.id)}/conversation-installs`,
        schema: installsResponseSchema,
      }),
    ),
  );
  const installs = installLists.flatMap(
    (result) => result.conversationInstalls,
  );
  return {
    providerAccounts: accounts.providerAccounts,
    agents: agents.agents,
    installs,
    conversations: conversations.conversations.map((conversation) =>
      mapConversation(
        conversation,
        accounts.providerAccounts,
        agents.agents,
        installs,
      ),
    ),
  };
}

export async function loadConversationDetail(
  transport: RuntimeApiTransport,
  conversationId: string,
  dashboard: ConversationDashboard,
): Promise<ConversationDetail> {
  const conversation = dashboard.conversations.find(
    (item) => item.id === conversationId,
  );
  if (!conversation) throw new Error('Conversation not found.');
  const encodedId = encodeURIComponent(conversationId);
  const [threads, messages, approvers] = await Promise.all([
    transport.request({
      path: `/conversations/${encodedId}/threads`,
      schema: threadsResponseSchema,
    }),
    transport.request({
      path: `/conversations/${encodedId}/messages`,
      query: { limit: 100 },
      schema: messagesResponseSchema,
    }),
    transport.request({
      path: `/conversations/${encodedId}/approvers`,
      schema: approversResponseSchema,
    }),
  ]);
  return {
    conversation,
    threads: threads.threads,
    messages: messages.messages.map(mapMessage),
    approverIds: approvers.approvers.userIds,
  };
}

export function discoverConversations(
  transport: RuntimeApiTransport,
  providerAccountId: string,
) {
  return transport.request({
    path: `/provider-accounts/${encodeURIComponent(providerAccountId)}/discover-conversations`,
    method: 'POST',
    body: { limit: 200 },
    schema: conversationsResponseSchema,
  });
}

export function replaceConversationApprovers(
  transport: RuntimeApiTransport,
  conversationId: string,
  userIds: string[],
) {
  return transport.request({
    path: `/conversations/${encodeURIComponent(conversationId)}/approvers`,
    method: 'PUT',
    body: { userIds },
    schema: approversResponseSchema,
  });
}

export async function replaceConversationInstall(
  transport: RuntimeApiTransport,
  input: {
    conversation: ConversationView;
    currentAgentId?: string;
    nextAgentId?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    approverUserIds?: string[];
  },
) {
  const conversationId = encodeURIComponent(input.conversation.id);
  if (!input.nextAgentId) return;
  await transport.request({
    path: `/agents/${encodeURIComponent(input.nextAgentId)}/conversation-installs/${conversationId}`,
    method: 'PUT',
    body: {
      providerAccountId: input.conversation.providerAccountId,
      displayName: input.conversation.name,
      memoryScope: 'conversation',
      memorySubject: { type: 'conversation', id: input.conversation.id },
      status: 'active',
      ...(input.trigger !== undefined || input.requiresTrigger !== undefined
        ? {
            routeConfig: {
              ...(input.trigger?.trim()
                ? { trigger: input.trigger.trim() }
                : {}),
              ...(input.requiresTrigger !== undefined
                ? { requiresTrigger: input.requiresTrigger }
                : {}),
            },
          }
        : {}),
    },
    schema: installSchema,
  });
  if (input.currentAgentId && input.currentAgentId !== input.nextAgentId) {
    await transport.request({
      path: `/agents/${encodeURIComponent(input.currentAgentId)}/conversation-installs/${conversationId}`,
      method: 'DELETE',
      schema: z.record(z.string(), z.unknown()),
    });
  }
  if (input.approverUserIds !== undefined) {
    await replaceConversationApprovers(
      transport,
      input.conversation.id,
      input.approverUserIds,
    );
  }
}

function mapConversation(
  conversation: z.infer<typeof conversationSchema>,
  accounts: z.infer<typeof providerAccountSchema>[],
  agents: AgentOption[],
  installs: ConversationInstall[],
): ConversationView {
  const install = installs.find(
    (item) =>
      item.conversationId === conversation.id && item.status === 'active',
  );
  return {
    id: conversation.id,
    name: conversation.title?.trim() || conversation.id,
    provider:
      accounts.find((item) => item.id === conversation.providerAccountId)
        ?.label ?? 'Unavailable',
    providerAccountId: conversation.providerAccountId,
    kind: formatKind(conversation.kind),
    agent:
      agents.find((item) => item.id === install?.agentId)?.name ??
      'Not installed',
    agentId: install?.agentId,
    status: conversation.status,
    updatedAt: conversation.updatedAt,
  };
}

function mapMessage(
  message: z.infer<typeof messageSchema>,
): ConversationMessageView {
  return {
    id: message.id,
    author: message.senderDisplayName ?? formatKind(message.direction),
    content: readableMessageText(message.parts),
    direction: message.direction,
    createdAt: message.createdAt,
  };
}

function readableMessageText(
  parts: z.infer<typeof messagePartSchema>[],
): string {
  const values = parts.flatMap((part) => {
    if (part.kind === 'text') return readPayloadString(part.payload, 'text');
    if (part.kind === 'markdown')
      return readPayloadString(part.payload, 'markdown');
    if (part.kind === 'code') return readPayloadString(part.payload, 'code');
    if (part.kind === 'redacted') return '[Redacted]';
    return [];
  });
  return values.join('\n\n') || 'Structured message content is not displayed.';
}

function readPayloadString(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return [];
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? [value] : [];
}

function formatKind(value: string): string {
  if (value === 'dm') return 'Direct message';
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ');
}
