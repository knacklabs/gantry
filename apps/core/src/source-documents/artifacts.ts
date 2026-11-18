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

import type {
  SourceDocumentRendererRequest,
  SourceDocumentFormat,
} from './renderer/types.js';
import { parseRendererRequest } from './renderer/validation.js';
import { hash } from '../adapters/storage/postgres/repositories/source-answer-base.postgres.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
export interface SourceDocumentCanonical {
  version: 1;
  title: string;
  blocks: SourceDocumentRendererRequest['blocks'];
  citationIds: string[];
  metadataFields: string[];
  revisionId: string;
  canonicalContentHash: string;
}
export function canonicalSourceDocument(
  document: SourceDocumentRendererRequest,
  refs: { citationIds: string[]; metadataFields: string[]; revisionId: string },
): SourceDocumentCanonical {
  const parsed = parseRendererRequest(Buffer.from(JSON.stringify(document)));
  for (const values of [refs.citationIds, refs.metadataFields])
    if (
      !Array.isArray(values) ||
      values.length > 100 ||
      values.some(
        (value) => typeof value !== 'string' || !value || value.length > 256,
      ) ||
      new Set(values).size !== values.length
    )
      throw new Error('Invalid canonical document references');
  if (
    typeof refs.revisionId !== 'string' ||
    !refs.revisionId ||
    refs.revisionId.length > 256
  )
    throw new Error('Invalid canonical document revision');
  const content = {
    version: 1 as const,
    title: parsed.title,
    blocks: parsed.blocks,
    citationIds: [...refs.citationIds],
    metadataFields: [...refs.metadataFields],
  };
  return {
    ...content,
    revisionId: refs.revisionId,
    canonicalContentHash: hash(content),
  };
}
export function readSourceDocumentCanonical(
  value: unknown,
  document: SourceDocumentRendererRequest,
): SourceDocumentCanonical {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Lossless conversion requires validated original content');
  const saved = value as SourceDocumentCanonical;
  const result = canonicalSourceDocument(
    { ...document, title: saved.title, blocks: saved.blocks },
    saved,
  );
  if (
    saved.version !== 1 ||
    result.canonicalContentHash !== saved.canonicalContentHash
  )
    throw new Error('Canonical document content integrity failed');
  return result;
}
export function convertSourceDocumentRequest(
  original: SourceDocumentRendererRequest,
  canonical: SourceDocumentCanonical,
  targetFormat: SourceDocumentFormat,
): SourceDocumentRendererRequest {
  if (!['pdf', 'docx'].includes(targetFormat))
    throw new Error('Unsupported document target format');
  return parseRendererRequest(
    Buffer.from(
      JSON.stringify({
        version: 1,
        format: targetFormat,
        fileName: original.fileName.replace(
          /\.(pdf|docx)$/u,
          `.${targetFormat}`,
        ),
        title: canonical.title,
        blocks: canonical.blocks,
      }),
    ),
  );
}
export async function readConvertibleSourceDocument(
  store: FileArtifactStore,
  artifact: FileArtifact,
) {
  const receipt = sourceDocumentReceipt(artifact);
  const original = await store.readFileArtifact({
    appId: artifact.appId,
    agentId: artifact.agentId,
    id: artifact.id,
  });
  verifySourceDocumentBytes(receipt, original.content);
  let canonicalValue = artifact.metadata.sourceDocumentCanonical;
  if (!canonicalValue) {
    const latest = await store.readFileArtifact({
      appId: artifact.appId,
      agentId: artifact.agentId,
      virtualScope: artifact.virtualScope,
      virtualPath: artifact.virtualPath,
    });
    if (
      latest.artifact.deletedAt ||
      latest.artifact.createdBy !== SOURCE_DOCUMENT_CREATED_BY ||
      latest.artifact.id === artifact.id ||
      latest.artifact.promotedFromArtifactId !== artifact.id ||
      latest.artifact.version !== artifact.version + 1 ||
      latest.artifact.contentHash !== artifact.contentHash ||
      hash(latest.artifact.metadata.sourceDocument) !==
        hash(artifact.metadata.sourceDocument)
    )
      throw new Error(
        'Lossless conversion requires validated original content',
      );
    verifySourceDocumentBytes(receipt, latest.content);
    canonicalValue = latest.artifact.metadata.sourceDocumentCanonical;
  }
  const raw = canonicalValue as SourceDocumentCanonical | undefined;
  const document = parseRendererRequest(
    Buffer.from(
      JSON.stringify({
        version: 1,
        format: receipt.format,
        fileName: receipt.fileName,
        title: raw?.title,
        blocks: raw?.blocks,
      }),
    ),
  );
  const canonical = readSourceDocumentCanonical(canonicalValue, document);
  assertSourceDocumentCanonicalManifest(receipt, canonical);
  return { receipt, canonical, document };
}

export function assertSourceDocumentCanonicalManifest(
  receipt: SourceDocumentArtifactReceipt,
  canonical: SourceDocumentCanonical,
) {
  const document = parseRendererRequest(
    Buffer.from(
      JSON.stringify({
        version: 1,
        format: receipt.format,
        fileName: receipt.fileName,
        title: canonical.title,
        blocks: canonical.blocks,
      }),
    ),
  );
  const verified = readSourceDocumentCanonical(canonical, document);
  if (
    hash(verified.citationIds) !== hash(receipt.citationIds) ||
    hash(verified.metadataFields) !== hash(receipt.metadataFields) ||
    (receipt.canonicalContentHash &&
      receipt.canonicalContentHash !== verified.canonicalContentHash) ||
    hash({
      document,
      citationIds: verified.citationIds,
      metadataFields: verified.metadataFields,
      answerGoalId: receipt.answerGoalId,
      attemptId: receipt.attemptId,
      runId: receipt.runId,
      binding: receipt.binding,
      ...(receipt.conversion ? { conversion: receipt.conversion } : {}),
    }) !== receipt.manifestHash
  )
    throw new Error('Original document manifest integrity failed');
}

/** Read-only recovery proposal. The caller must obtain the exact original tool input from the official checkpoint. */
export function planSourceDocumentCanonicalRecovery(
  artifact: FileArtifact,
  content: Uint8Array | string,
  recovered: {
    document: SourceDocumentRendererRequest;
    citationIds: string[];
    metadataFields: string[];
    revisionId: string;
  },
) {
  const receipt = sourceDocumentReceipt(artifact);
  verifySourceDocumentBytes(receipt, content);
  const canonical = canonicalSourceDocument(recovered.document, recovered);
  if (
    recovered.document.format !== receipt.format ||
    recovered.document.fileName !== receipt.fileName
  )
    throw new Error(
      'Recovered document format does not match the original receipt',
    );
  assertSourceDocumentCanonicalManifest(receipt, canonical);
  if (artifact.metadata.sourceDocumentCanonical) {
    const existing = readSourceDocumentCanonical(
      artifact.metadata.sourceDocumentCanonical,
      recovered.document,
    );
    if (existing.canonicalContentHash !== canonical.canonicalContentHash)
      throw new Error('Existing canonical recovery conflict');
  }
  return {
    readOnly: true as const,
    artifactId: artifact.id,
    originalSHA256: receipt.sha256,
    originalManifestHash: receipt.manifestHash,
    canonicalContentHash: canonical.canonicalContentHash,
    alreadyCanonical: !!artifact.metadata.sourceDocumentCanonical,
    casProposal: {
      appId: artifact.appId,
      agentId: artifact.agentId,
      virtualScope: artifact.virtualScope,
      virtualPath: artifact.virtualPath,
      expectedVersion: artifact.version,
      promotedFromArtifactId: artifact.id,
      contentType: artifact.contentType,
      createdBy: artifact.createdBy,
      metadata: { ...artifact.metadata, sourceDocumentCanonical: canonical },
    },
    writePerformed: false as const,
  };
}
