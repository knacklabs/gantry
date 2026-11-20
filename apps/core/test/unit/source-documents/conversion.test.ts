import { describe, it, expect } from 'vitest';
import {
  canonicalSourceDocument,
  convertSourceDocumentRequest,
  readSourceDocumentCanonical,
} from '../../../src/source-documents/artifacts.js';
const document = {
  version: 1 as const,
  format: 'pdf' as const,
  fileName: 'Checklist.pdf',
  title: 'Exact checklist',
  blocks: [
    {
      type: 'table' as const,
      headers: ['Requirement', 'Status'],
      rows: [['Do not change this content', '☐']],
    },
  ],
};
const refs = {
  citationIds: ['E1'],
  metadataFields: ['title'],
  revisionId: 'REV',
};
describe('deterministic format conversion', () => {
  it('changes only format and extension while preserving canonical title/blocks/references/hash', () => {
    const canonical = canonicalSourceDocument(document, refs);
    const converted = convertSourceDocumentRequest(document, canonical, 'docx');
    expect(converted).toEqual({
      ...document,
      format: 'docx',
      fileName: 'Checklist.docx',
    });
    expect(canonicalSourceDocument(converted, refs)).toEqual(canonical);
  });
  it('rejects changed canonical content rather than silently rendering a replacement', () => {
    const canonical = canonicalSourceDocument(document, refs);
    expect(() =>
      readSourceDocumentCanonical(
        { ...canonical, title: 'Rewritten' },
        document,
      ),
    ).toThrow();
  });
});

import { createHash } from 'node:crypto';
import { createSourceDocument } from '../../../src/source-documents/service.js';
import {
  assertSourceDocumentCanonicalManifest,
  sourceDocumentReceipt,
} from '../../../src/source-documents/artifacts.js';
import { launchSourceDocumentRenderer } from '../../../src/source-documents/launcher.js';
import type { FileArtifact } from '../../../src/domain/file-artifacts/file-artifact.js';
import type { FileArtifactWriteInput } from '../../../src/domain/ports/file-artifact-store.js';
import { fileURLToPath } from 'node:url';
class MemoryStore {
  rows: { artifact: FileArtifact; content: Uint8Array }[] = [];
  async writeFileArtifact(input: FileArtifactWriteInput) {
    const content = Buffer.from(input.content);
    const artifact = {
      id: `F${this.rows.length + 1}` as never,
      appId: input.appId,
      agentId: input.agentId,
      virtualScope: input.virtualScope,
      virtualPath: input.virtualPath,
      version: 1,
      storageType: 'local-filesystem' as const,
      storageRef: 'private',
      contentHash:
        'sha256:' + createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length,
      contentType: input.contentType!,
      metadata: structuredClone(input.metadata ?? {}),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.rows.push({ artifact, content });
    return artifact;
  }
  async readFileArtifact(input: {
    id?: string;
    virtualScope?: string;
    virtualPath?: string;
  }) {
    const row = this.rows.find((row) =>
      input.id
        ? row.artifact.id === input.id
        : row.artifact.virtualScope === input.virtualScope &&
          row.artifact.virtualPath === input.virtualPath,
    );
    if (!row) throw Error('Missing artifact');
    return row;
  }
  async listFileArtifacts(input: { virtualScope: string }) {
    return this.rows
      .filter((row) => row.artifact.virtualScope === input.virtualScope)
      .map(({ artifact }) => ({ id: artifact.id, path: artifact.virtualPath }));
  }
}
async function flow(actual = false) {
  const store = new MemoryStore();
  let goal = 'original',
    runId = 'OLD';
  const launched: (typeof document)[] = [];
  const scope = () => ({
    appId: 'app',
    agentId: 'agent',
    chatJid: 'app:app:D',
    personId: 'person',
    workspaceId: 'W',
    runId,
  });
  const context = () => ({
    answerId: goal,
    sessionId: 'S',
    conversationId: 'C',
    claimToken: 'lease',
    scope: scope(),
    subject: {} as never,
    deadlineAtMs: Date.now() + 60000,
    request: {
      binding: {
        discussionId: 'D',
        generation: 1,
        workspaceId: 'W',
        tenderId: 'T',
      },
      answerGoalId: goal,
      attemptId: goal,
      revisionId: 'REV',
    },
  });
  const repository = {
    context: async () => context(),
    acquire: async () => true,
    release: async () => {},
    authorize: async () => {},
  } as never;
  const launch: typeof launchSourceDocumentRenderer = async (
    request,
    options,
  ) => {
    launched.push(structuredClone(request) as typeof document);
    if (actual)
      return launchSourceDocumentRenderer(request, {
        ...options,
        entrypoint: fileURLToPath(
          new URL(
            '../../../../../dist/source-documents/renderer/cli.js',
            import.meta.url,
          ),
        ),
      });
    const bytes = Buffer.from(
      request.format === 'pdf' ? '%PDF-1.7\nfixture' : 'PK\x03\x04fixture',
    );
    return {
      bytes,
      result: {
        version: 1,
        rendererVersion: 'fixture',
        fileName: request.fileName,
        contentType:
          request.format === 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytesBase64: bytes.toString('base64'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
      },
    };
  };
  const original = await createSourceDocument({
    scope: scope(),
    document,
    citationIds: refs.citationIds,
    metadataFields: refs.metadataFields,
    store: store as never,
    repository,
    launch,
  });
  const originalState = structuredClone(store.rows[0]!.artifact);
  goal = 'converted';
  runId = 'CURRENT';
  const selected = async () => ({
    sourceMessageId: 'published-source',
    receipt: original,
  });
  const input = {
    scope: scope(),
    convertExistingArtifactId: original.artifactId,
    targetFormat: 'docx' as const,
    store: store as never,
    repository,
    launch,
    selectOriginal: selected as never,
  };
  const converted = await createSourceDocument(input);
  return { store, original, originalState, converted, launched, input };
}
it('keeps scope, original bytes and canonical content intact while issuing a new owned receipt and replay', async () => {
  const value = await flow();
  expect(value.converted.runId).toBe('CURRENT');
  expect(value.converted.answerGoalId).toBe('converted');
  expect(value.converted.conversion).toEqual({
    artifactId: value.original.artifactId,
    sourceMessageId: 'published-source',
    sha256: value.original.sha256,
    manifestHash: value.original.manifestHash,
  });
  expect(value.converted.canonicalContentHash).toBe(
    value.original.canonicalContentHash,
  );
  expect(value.launched[1]).toEqual({
    ...document,
    format: 'docx',
    fileName: 'Checklist.docx',
  });
  expect(value.store.rows[0]!.artifact).toEqual(value.originalState);
  expect(await createSourceDocument(value.input)).toEqual(value.converted);
  expect(value.launched).toHaveLength(2);
  assertSourceDocumentCanonicalManifest(
    value.original,
    value.store.rows[1]!.artifact.metadata.sourceDocumentCanonical as never,
  );
  assertSourceDocumentCanonicalManifest(
    value.converted,
    value.store.rows[1]!.artifact.metadata.sourceDocumentCanonical as never,
  );
  await expect(
    createSourceDocument({ ...value.input, document }),
  ).rejects.toThrow(/cannot replace/);
  await expect(
    createSourceDocument({
      ...value.input,
      selectOriginal: async () => {
        throw Error('outside selected context');
      },
    }),
  ).rejects.toThrow(/outside selected/);
});
it('runs the actual packaged PDF and DOCX subprocesses with identical canonical content and manifest proof', async () => {
  const value = await flow(true);
  expect(
    Buffer.from(value.store.rows[0]!.content).subarray(0, 5).toString(),
  ).toBe('%PDF-');
  expect(Buffer.from(value.store.rows[1]!.content).subarray(0, 4)).toEqual(
    Buffer.from([0x50, 0x4b, 3, 4]),
  );
  expect(value.converted.canonicalContentHash).toBe(
    value.original.canonicalContentHash,
  );
  expect(
    value.store.rows[0]!.artifact.metadata.sourceDocumentCanonical,
  ).toEqual(value.store.rows[1]!.artifact.metadata.sourceDocumentCanonical);
  assertSourceDocumentCanonicalManifest(
    value.original,
    value.store.rows[1]!.artifact.metadata.sourceDocumentCanonical as never,
  );
  assertSourceDocumentCanonicalManifest(
    value.converted,
    value.store.rows[1]!.artifact.metadata.sourceDocumentCanonical as never,
  );
}, 60000);

import {planSourceDocumentCanonicalRecovery} from '../../../src/source-documents/artifacts.js';
it('prepares only a hash-proven versioned recovery proposal and never writes or regenerates',async()=>{
 const value=await flow();const legacy=structuredClone(value.store.rows[0]!.artifact);delete legacy.metadata.sourceDocumentCanonical;
 const before=value.store.rows.length;
 const proposal=planSourceDocumentCanonicalRecovery(legacy,value.store.rows[0]!.content,{document,...refs});
 expect(proposal).toMatchObject({readOnly:true,writePerformed:false,alreadyCanonical:false,artifactId:legacy.id,casProposal:{expectedVersion:legacy.version,promotedFromArtifactId:legacy.id,virtualScope:legacy.virtualScope,virtualPath:legacy.virtualPath}});
 expect(value.store.rows).toHaveLength(before);
 expect(()=>planSourceDocumentCanonicalRecovery(legacy,value.store.rows[0]!.content,{document:{...document,title:'Regenerated'},...refs})).toThrow(/manifest/);
});
