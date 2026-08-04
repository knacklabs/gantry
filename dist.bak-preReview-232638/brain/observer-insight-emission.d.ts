import type { ObserverInsightCursor, ObserverInsightEvidenceRef, ObserverInsightRepository, ObserverInsightType, ObserverSubjectKey } from '../domain/ports/observer-insights.js';
import type { PatternCandidateRepository } from '../domain/ports/pattern-candidates.js';
import { type ObserverActiveMemoryReadPort } from '../memory/observer-active-memory.js';
import type { EmbeddingProvider } from '../memory/memory-embeddings.js';
import type { BrainPage } from './brain-types.js';
export declare const OBSERVER_APP_SUBJECT: ObserverSubjectKey;
export declare const OBSERVER_CURSOR_SUBJECT: ObserverSubjectKey;
export declare const OBSERVER_EMBEDDINGS_UNAVAILABLE_MESSAGE = "Insight emission paused: embeddings unavailable.";
export interface SurfaceableInsightDraft {
    insightType: Exclude<ObserverInsightType, 'repetition'>;
    title: string;
    summary: string;
    canonicalSignature: string;
    confidence: number;
    evidencePageIds: string[];
}
export type ObserverInsightEmissionRuntime = {
    enabled: false;
} | {
    enabled: true;
    ownerRecipient: string;
    cursorSubject: ObserverSubjectKey;
    repository: ObserverInsightRepository;
    patterns: PatternCandidateRepository;
    activeMemory: ObserverActiveMemoryReadPort;
    embedding?: EmbeddingProvider;
    embeddingModel: string;
    embeddingDimensions: number;
};
interface PageDraft {
    draft: SurfaceableInsightDraft;
    page: BrainPage;
}
interface NormalizedCandidate {
    subject: ObserverSubjectKey;
    insightType: ObserverInsightType;
    title: string;
    summary: string;
    content: string;
    signatureIdentity: string;
    confidence: number;
    evidenceRefs: ObserverInsightEvidenceRef[];
    batchSnapshotAt: string;
}
export declare function normalizeSurfaceableInsightDraft(value: unknown, evidencePageId: string): SurfaceableInsightDraft | null;
interface ChannelSourceRef {
    providerAccountId: string;
    conversationJid: string;
    discriminator: string;
}
/**
 * Channel pages encode `${providerAccountId}:${chat_jid}#${discriminator}`
 * (see brain-channel-harvest.ts). The provider account is the first segment;
 * the chat_jid can itself contain colons (e.g. `<provider>:C123`). The account is
 * load-bearing: conversation ids are only unique per provider account.
 */
export declare function parseChannelSourceRef(sourceRef: string | null): ChannelSourceRef | null;
export declare function observerSubjectForPage(page: BrainPage): ObserverSubjectKey;
export declare function emitObserverInsights(input: {
    enabled: true;
    appId: string;
    ownerRecipient: string;
    cursorSubject: ObserverSubjectKey;
    repository: ObserverInsightRepository;
    patterns: PatternCandidateRepository;
    activeMemory: ObserverActiveMemoryReadPort;
    embedding?: EmbeddingProvider;
    embeddingModel: string;
    embeddingDimensions: number;
    drafts: PageDraft[];
    cursor: ObserverInsightCursor | null;
    cursorTarget?: BrainPage;
    signal?: AbortSignal;
}): Promise<{
    persisted: number;
    deduplicated: number;
    filtered: number;
    message: string;
}>;
export declare function normalizePageCandidate(input: PageDraft): NormalizedCandidate | null;
export {};
