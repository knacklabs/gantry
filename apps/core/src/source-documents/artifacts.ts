import { createHash } from 'node:crypto';
import {
  SourceDocumentArtifactReceiptSchema,
  type SourceDocumentArtifactReceipt,
} from '@gantry/contracts';
import type { FileArtifact } from '../domain/file-artifacts/file-artifact.js';
export const SOURCE_DOCUMENT_CREATED_BY = 'host:source-document-renderer';
export function sourceDocumentReceipt(
  artifact: FileArtifact,
): SourceDocumentArtifactReceipt {
  const receipt = SourceDocumentArtifactReceiptSchema.parse({
    ...(artifact.metadata.sourceDocument as Record<string, unknown>),
    artifactId: artifact.id,
  });
  if (
    !!artifact.deletedAt ||
    artifact.createdBy !== SOURCE_DOCUMENT_CREATED_BY ||
    artifact.sizeBytes !== receipt.sizeBytes ||
    artifact.contentHash !== `sha256:${receipt.sha256}` ||
    artifact.contentType !== receipt.contentType ||
    !receipt.fileName.endsWith(`.${receipt.format}`) ||
    receipt.contentType !==
      (receipt.format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  )
    throw new Error('Untrusted source document artifact');
  return receipt;
}
export function verifySourceDocumentBytes(
  receipt: SourceDocumentArtifactReceipt,
  content: Uint8Array | string,
): Buffer {
  if (typeof content === 'string')
    throw new Error('Source document bytes unavailable');
  const bytes = Buffer.from(content);
  if (
    bytes.length !== receipt.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== receipt.sha256 ||
    !(receipt.format === 'pdf'
      ? bytes.subarray(0, 5).toString() === '%PDF-'
      : bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
  )
    throw new Error('Source document bytes failed integrity verification');
  return bytes;
}
