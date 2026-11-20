import { selectedSourceDocument } from '../adapters/storage/postgres/repositories/source-document-output.postgres.js';
import type { SourceDocumentArtifactReceipt } from '@gantry/contracts';
import { randomUUID } from 'node:crypto';
import { hash } from '../adapters/storage/postgres/repositories/source-answer-base.postgres.js';
import { PostgresSourceLearningRepository } from '../adapters/storage/postgres/repositories/source-learning-repository.postgres.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { sourceChannelMemorySubject } from '../memory/source-channel-memory-scope.js';
import type {
  SourceLearningContext,
  SourceLearningScope,
} from '../domain/ports/source-learning.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import { launchSourceDocumentRenderer } from './launcher.js';
import type { SourceDocumentRendererRequest } from './renderer/types.js';
import {
  SOURCE_DOCUMENT_CREATED_BY,
  sourceDocumentReceipt,
  canonicalSourceDocument,
  readConvertibleSourceDocument,
  convertSourceDocumentRequest,
} from './artifacts.js';
export async function createSourceDocument(input: {
  scope: SourceLearningScope;
  document?: SourceDocumentRendererRequest;
  citationIds?: string[];
  metadataFields?: string[];
  convertExistingArtifactId?: string;
  targetFormat?: 'pdf' | 'docx';
  store: FileArtifactStore;
  repository?: PostgresSourceLearningRepository;
  launch?: typeof launchSourceDocumentRenderer;
  selectOriginal?: (
    context: SourceLearningContext,
    artifactId: string,
  ) => ReturnType<typeof selectedSourceDocument>;
}) {
  const repo =
    input.repository ??
    new PostgresSourceLearningRepository(getRuntimeStorage().service.db);
  const subject = sourceChannelMemorySubject({
    ...input.scope,
    scope: 'group',
  });
  const context = await repo.context(input.scope, subject);
  let document = input.document;
  let citationIds = input.citationIds;
  let metadataFields = input.metadataFields;
  let conversion: SourceDocumentArtifactReceipt['conversion'];
  if (input.convertExistingArtifactId !== undefined) {
    if (
      document !== undefined ||
      citationIds !== undefined ||
      metadataFields !== undefined ||
      !['pdf', 'docx'].includes(input.targetFormat ?? '')
    )
      throw new Error('Conversion cannot replace original document content');
    const selected = await (
      input.selectOriginal ??
      ((context, id) =>
        selectedSourceDocument(getRuntimeStorage().service.db, context, id))
    )(context, input.convertExistingArtifactId);
    const original = await input.store.readFileArtifact({
      appId: input.scope.appId,
      agentId: input.scope.agentId,
      id: input.convertExistingArtifactId as never,
    });
    const preserved = await readConvertibleSourceDocument(
      input.store,
      original.artifact,
    );
    if (
      hash(preserved.receipt) !== hash(selected.receipt) ||
      preserved.canonical.revisionId !== context.request.revisionId
    )
      throw new Error('Original document conversion proof mismatch');
    document = convertSourceDocumentRequest(
      preserved.document,
      preserved.canonical,
      input.targetFormat!,
    );
    citationIds = preserved.canonical.citationIds;
    metadataFields = preserved.canonical.metadataFields;
    conversion = {
      artifactId: selected.receipt.artifactId,
      sourceMessageId: selected.sourceMessageId,
      sha256: selected.receipt.sha256,
      manifestHash: selected.receipt.manifestHash,
    };
  } else if (input.targetFormat !== undefined)
    throw new Error('Conversion requires an original artifact');
  if (!document || !citationIds || !metadataFields)
    throw new Error('Document content is required');
  const canonical = canonicalSourceDocument(document, {
    citationIds,
    metadataFields,
    revisionId: context.request.revisionId,
  });
  const holder = randomUUID();
  if (!(await repo.acquire(context, holder)))
    throw new Error('Another native source operation is in progress');
  try {
    const manifestHash = hash({
      document,
      citationIds,
      metadataFields,
      answerGoalId: context.request.answerGoalId,
      attemptId: context.request.attemptId,
      runId: input.scope.runId,
      binding: context.request.binding,
      ...(conversion ? { conversion } : {}),
    });
    const virtualScope = `source-document_${hash([input.scope.appId, context.request.answerGoalId, context.request.attemptId])}`;
    const owner = { appId: input.scope.appId, agentId: input.scope.agentId };
    const artifacts = await input.store.listFileArtifacts({
      ...owner,
      virtualScope,
      limit: 5,
    });
    const existing = artifacts.find(
      (row) => row.path === `${manifestHash}.${document.format}`,
    );
    const candidate = {
      id: `source-document:${manifestHash}`,
      context,
      evidence: [],
      replayed: !!existing,
    };
    if (existing) {
      const artifact = await input.store.readFileArtifact({
        ...owner,
        id: existing.id,
      });
      await repo.authorize(
        candidate,
        'publication',
        Math.min(context.deadlineAtMs, Date.now() + 10000),
      );
      await repo.context(input.scope, subject);
      return sourceDocumentReceipt(artifact.artifact);
    }
    if (artifacts.length >= 4)
      throw new Error('At most four documents may be generated per answer');
    await repo.authorize(
      candidate,
      'evidence',
      Math.min(context.deadlineAtMs, Date.now() + 10000),
    );
    const abort = new AbortController();
    let checking = false;
    const monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      void repo
        .context(input.scope, subject)
        .catch(() => abort.abort())
        .finally(() => {
          checking = false;
        });
    }, 250);
    let rendered;
    try {
      rendered = await (input.launch ?? launchSourceDocumentRenderer)(
        document,
        { deadlineAtMs: context.deadlineAtMs, signal: abort.signal },
      );
    } finally {
      clearInterval(monitor);
    }
    await repo.authorize(
      candidate,
      'publication',
      Math.min(context.deadlineAtMs, Date.now() + 10000),
    );
    await repo.context(input.scope, subject);
    const { bytesBase64, ...output } = rendered.result;
    const metadata = {
      sessionId: context.sessionId,
      runId: input.scope.runId,
      answerGoalId: context.request.answerGoalId,
      attemptId: context.request.attemptId,
      binding: context.request.binding,
      format: document.format,
      fileName: output.fileName,
      contentType: output.contentType,
      sizeBytes: output.sizeBytes,
      sha256: output.sha256,
      rendererVersion: output.rendererVersion,
      manifestHash,
      citationIds,
      metadataFields,
      canonicalContentHash: canonical.canonicalContentHash,
      ...(conversion ? { conversion } : {}),
    };
    const artifact = await input.store.writeFileArtifact({
      ...owner,
      virtualScope,
      virtualPath: `${manifestHash}.${document.format}`,
      content: rendered.bytes,
      contentType: output.contentType,
      createdBy: SOURCE_DOCUMENT_CREATED_BY,
      metadata: {
        sourceDocument: metadata,
        sourceDocumentCanonical: canonical,
      },
    });
    return sourceDocumentReceipt(artifact);
  } finally {
    await repo.release(context, holder);
  }
}
