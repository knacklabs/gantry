import type {
  HistoricalAttachmentFetcher,
  HistoricalAttachmentFetchResult,
} from '../../domain/ports/historical-attachment-fetcher.js';

type HistoricalAttachmentChannel = Partial<HistoricalAttachmentFetcher>;

export async function fetchHistoricalAttachmentFromChannel(
  input: Parameters<
    HistoricalAttachmentFetcher['fetchHistoricalAttachment']
  >[0],
  findChannel: (conversationJid: string, providerAccountId?: string) => unknown,
): Promise<HistoricalAttachmentFetchResult> {
  const channel = findChannel(input.conversationJid, input.providerAccountId);
  if (
    !channel ||
    typeof channel !== 'object' ||
    !('fetchHistoricalAttachment' in channel) ||
    typeof (channel as HistoricalAttachmentChannel)
      .fetchHistoricalAttachment !== 'function'
  ) {
    return { status: 'unreachable', reason: 'incapable' };
  }
  return (channel as HistoricalAttachmentFetcher).fetchHistoricalAttachment(
    input,
  );
}
