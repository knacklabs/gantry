export interface HistoricalAttachmentReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

export interface HistoricalAttachmentFetchIdentity {
  provider: string;
  kind: string;
  id: string;
  [key: string]: unknown;
}

export type HistoricalAttachmentUnreachableReason =
  | 'incapable'
  | 'not_found'
  | 'not_visible'
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'unknown';

export type HistoricalAttachmentUnreachableEvidence =
  | { reason: 'missing_scope'; scope: string }
  | { reason: HistoricalAttachmentUnreachableReason };

export type HistoricalAttachmentFetchResult =
  | {
      status: 'ok';
      content: Uint8Array | HistoricalAttachmentReader;
      fileName?: string;
      contentType?: string;
    }
  | { status: 'deleted' }
  | ({ status: 'unreachable' } & HistoricalAttachmentUnreachableEvidence);

export interface HistoricalAttachmentFetcher {
  fetchHistoricalAttachment(input: {
    identity: HistoricalAttachmentFetchIdentity;
    conversationJid: string;
    threadId?: string;
    providerAccountId?: string;
    signal?: AbortSignal;
  }): Promise<HistoricalAttachmentFetchResult>;
}
