import type { AppMemorySearchInput, MemoryScope, NormalizedMemorySubject } from './memory-types.js';
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
export declare function memoryScopeForConversationKind(conversationKind: string | undefined): EffectiveScope;
export declare function resolveScopedMemorySubject(input: MemorySubjectResolutionInput): {
    subject: NormalizedMemorySubject;
    scope: MemoryScope;
};
export declare function searchInputForResolvedMemorySubject(subject: NormalizedMemorySubject): Pick<AppMemorySearchInput, 'appId' | 'agentId' | 'userId' | 'groupId' | 'channelId' | 'subjectTypes' | 'includeCommon'>;
