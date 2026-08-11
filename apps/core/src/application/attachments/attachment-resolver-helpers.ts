import type { HistoricalAttachmentReader } from '../../domain/ports/historical-attachment-fetcher.js';

export function isWorkspaceLocalAttachmentStorageRef(
  storageRef: string,
): boolean {
  return (
    storageRef.startsWith('attachments/') &&
    storageRef.length > 'attachments/'.length &&
    !storageRef.includes('\\') &&
    !storageRef.split('/').includes('..')
  );
}

export function historicalAttachmentReader(
  content: Uint8Array | HistoricalAttachmentReader,
): HistoricalAttachmentReader | undefined {
  return 'read' in content ? content : undefined;
}
