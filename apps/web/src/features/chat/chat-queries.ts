import { queryOptions } from '@tanstack/react-query';

import { memories, messagesBySession, sessions } from './chat-preview';

export const chatQueryKeys = {
  all: ['chat'] as const,
  sessions: () => [...chatQueryKeys.all, 'sessions'] as const,
  messages: (sessionId: string) =>
    [...chatQueryKeys.all, 'messages', sessionId] as const,
  memories: () => [...chatQueryKeys.all, 'memories'] as const,
};

export const sessionPreviewQuery = queryOptions({
  queryKey: chatQueryKeys.sessions(),
  queryFn: () => sessions,
  initialData: sessions,
});

export function messagePreviewQuery(sessionId: string) {
  const messages = messagesBySession[sessionId] ?? [];
  return queryOptions({
    queryKey: chatQueryKeys.messages(sessionId),
    queryFn: () => messages,
    initialData: messages,
  });
}

export const memoryPreviewQuery = queryOptions({
  queryKey: chatQueryKeys.memories(),
  queryFn: () => memories,
  initialData: memories,
});
