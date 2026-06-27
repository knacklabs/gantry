import { canonicalConversationIdForPattern as canonicalConversationIdForMemory } from '../shared/pattern-candidate-subject.js';
import { normalizeSubject } from './app-memory-boundaries.js';
import type {
  AppMemorySearchInput,
  MemoryBoundaryContext,
  MemoryScope,
  NormalizedMemorySubject,
} from './memory-types.js';

export { canonicalConversationIdForPattern as canonicalConversationIdForMemory } from '../shared/pattern-candidate-subject.js';

export interface MemorySubjectResolutionInput {
  appId: string;
  agentId: string;
  groupId?: string;
  conversationId?: string;
  userId?: string;
  threadId?: string;
  defaultScope?: 'user' | 'group';
  scope?: MemoryScope;
}

type EffectiveScope = Exclude<MemoryScope, 'global'>;

export function memoryScopeForConversationKind(
  conversationKind: string | undefined,
): EffectiveScope {
  const kind = conversationKind?.trim().toLowerCase();
  if (kind === 'dm' || kind === 'direct' || kind === 'private') return 'user';
  return 'group';
}

export function resolveScopedMemorySubject(
  input: MemorySubjectResolutionInput,
): {
  subject: NormalizedMemorySubject;
  scope: MemoryScope;
} {
  const defaultScope = input.defaultScope === 'user' ? 'user' : 'group';
  const scope = input.scope || defaultScope;
  if (scope === 'global') {
    return {
      scope,
      subject: normalizeSubject({
        appId: input.appId,
        agentId: input.agentId,
        subjectType: 'common',
        subjectId: 'common',
      }),
    };
  }
  if (scope === 'user') {
    const userId = input.userId?.trim();
    if (!userId) {
      throw new Error('user-scoped memory requires an authenticated user');
    }
    return {
      scope,
      subject: normalizeSubject({
        appId: input.appId,
        agentId: input.agentId,
        userId,
        subjectType: 'user',
      }),
    };
  }
  const channelId = canonicalConversationIdForMemory(input.conversationId);
  if (channelId) {
    return {
      scope,
      subject: normalizeSubject({
        appId: input.appId,
        agentId: input.agentId,
        groupId: input.groupId?.trim() || input.agentId,
        channelId,
        subjectType: 'channel',
      }),
    };
  }
  return {
    scope,
    subject: normalizeSubject({
      appId: input.appId,
      agentId: input.agentId,
      groupId: input.groupId?.trim() || input.agentId,
      subjectType: 'group',
    }),
  };
}

export function searchInputForResolvedMemorySubject(
  subject: NormalizedMemorySubject,
): Pick<
  AppMemorySearchInput,
  | 'appId'
  | 'agentId'
  | 'userId'
  | 'groupId'
  | 'channelId'
  | 'subjectTypes'
  | 'includeCommon'
> {
  const scoped: Partial<MemoryBoundaryContext> = {};
  if (subject.subjectType === 'user') {
    scoped.userId = subject.userId ?? subject.subjectId;
  } else if (subject.subjectType === 'channel') {
    scoped.channelId = subject.channelId ?? subject.subjectId;
  } else if (subject.subjectType === 'group') {
    scoped.groupId = subject.groupId ?? subject.subjectId;
  }
  return {
    appId: subject.appId,
    agentId: subject.agentId,
    ...scoped,
    subjectTypes: [subject.subjectType],
    includeCommon: false,
  };
}
