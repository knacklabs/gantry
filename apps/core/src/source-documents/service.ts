import { randomUUID } from 'node:crypto';
import { hash } from '../adapters/storage/postgres/repositories/source-answer-base.postgres.js';
import { PostgresSourceLearningRepository } from '../adapters/storage/postgres/repositories/source-learning-repository.postgres.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { sourceChannelMemorySubject } from '../memory/source-channel-memory-scope.js';
import type { SourceLearningScope } from '../domain/ports/source-learning.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import { launchSourceDocumentRenderer } from './launcher.js';
import type { SourceDocumentRendererRequest } from './renderer/types.js';
import {
  SOURCE_DOCUMENT_CREATED_BY,
  sourceDocumentReceipt,
} from './artifacts.js';
export async function createSourceDocument(input: {
  scope: SourceLearningScope;
  document: SourceDocumentRendererRequest;
  citationIds: string[];
  metadataFields: string[];
  store: FileArtifactStore;
  repository?: PostgresSourceLearningRepository;
  launch?: typeof launchSourceDocumentRenderer;
}) {
  const repo =
    input.repository ??
    new PostgresSourceLearningRepository(getRuntimeStorage().service.db);
  const subject = sourceChannelMemorySubject({
    ...input.scope,
    scope: 'group',
  });
  const context = await repo.context(input.scope, subject);
  for (const refs of [input.citationIds, input.metadataFields])
    if (
      !Array.isArray(refs) ||
      refs.length > 100 ||
      refs.some((ref) => typeof ref !== 'string' || !ref || ref.length > 256) ||
      new Set(refs).size !== refs.length
    )
      throw new Error('Invalid source document references');
  const holder = randomUUID();
  if (!(await repo.acquire(context, holder)))
    throw new Error('Another native source operation is in progress');
  try {
    const manifestHash = hash({
      document: input.document,
      citationIds: input.citationIds,
      metadataFields: input.metadataFields,
      answerGoalId: context.request.answerGoalId,
      attemptId: context.request.attemptId,
      runId: input.scope.runId,
      binding: context.request.binding,
    });
    const virtualScope = `source-document_${hash([input.scope.appId, context.request.answerGoalId, context.request.attemptId])}`;
    const owner = { appId: input.scope.appId, agentId: input.scope.agentId };
    const artifacts = await input.store.listFileArtifacts({
      ...owner,
      virtualScope,
      limit: 5,
    });
    const existing = artifacts.find(
      (row) => row.path === `${manifestHash}.${input.document.format}`,
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
        input.document,
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
      format: input.document.format,
      fileName: output.fileName,
      contentType: output.contentType,
      sizeBytes: output.sizeBytes,
      sha256: output.sha256,
      rendererVersion: output.rendererVersion,
      manifestHash,
      citationIds: input.citationIds,
      metadataFields: input.metadataFields,
    };
    const artifact = await input.store.writeFileArtifact({
      ...owner,
      virtualScope,
      virtualPath: `${manifestHash}.${input.document.format}`,
      content: rendered.bytes,
      contentType: output.contentType,
      createdBy: SOURCE_DOCUMENT_CREATED_BY,
      metadata: { sourceDocument: metadata },
    });
    return sourceDocumentReceipt(artifact);
  } finally {
    await repo.release(context, holder);
  }
}
