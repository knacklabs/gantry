import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { PostgresCanonicalMessageRepository } from '@core/adapters/storage/postgres/repositories/canonical-message-repository.postgres.js';
import { PostgresMessageAttachmentRepository } from '@core/adapters/storage/postgres/repositories/message-attachment-repository.postgres.js';
import { CanonicalMessageOpsService } from '@core/adapters/storage/postgres/services/canonical-message-ops-service.js';
import {
  ATTACHMENT_DELETED_COPY,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NOT_FOUND_COPY,
  ATTACHMENT_TOO_LARGE_COPY,
  ATTACHMENT_UNREACHABLE_COPY,
  AttachmentResolver,
} from '@core/application/attachments/attachment-resolver.js';
import { fetchSlackHistoricalAttachment } from '@core/channels/slack/historical-attachment-fetcher.js';
import type {
  HistoricalAttachmentFetcher,
  HistoricalAttachmentFetchResult,
} from '@core/domain/ports/historical-attachment-fetcher.js';
import type { NewMessage } from '@core/domain/types.js';
import { writeInboundAttachment } from '@core/shared/inbound-attachment-writer.js';
import { removeProviderAttachment } from '@core/shared/provider-attachment-materialization.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const appId = 'default';
const providerAccountId = 'slack_file_1a_postgres';
const workspaceRoots = [process.cwd()];
const temporaryRoots: string[] = [];

type SlackFileBehavior =
  | {
      status: 'ok';
      content: Uint8Array | (() => ReadableStream<Uint8Array>);
      fileName?: string;
      contentType?: string;
    }
  | { status: 'deleted' | 'not_found' };

function materializationRoot(label: string): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `gantry-file-1a-${label}-`),
  );
  temporaryRoots.push(root);
  return root;
}

function fakeSlackFetcher(behaviors: Record<string, SlackFileBehavior>): {
  fetcher: HistoricalAttachmentFetcher;
  fetchHistoricalAttachment: ReturnType<typeof vi.fn>;
  filesInfo: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
} {
  const filesInfo = vi.fn(async (fileId: string) => {
    const behavior = behaviors[fileId];
    if (!behavior) {
      throw new Error(`Missing fake Slack behavior for ${fileId}`);
    }
    if (behavior.status !== 'ok') {
      throw {
        data: {
          error:
            behavior.status === 'deleted' ? 'file_deleted' : 'file_not_found',
        },
      };
    }
    return {
      file: {
        name: behavior.fileName,
        mimetype: behavior.contentType,
        url_private_download: `https://slack.test/files/${fileId}`,
      },
    };
  });
  const download = vi.fn(async (url: string) => {
    const fileId = url.slice(url.lastIndexOf('/') + 1);
    const behavior = behaviors[fileId];
    if (!behavior || behavior.status !== 'ok') {
      throw new Error(`Unexpected fake Slack download for ${fileId}`);
    }
    const content =
      typeof behavior.content === 'function'
        ? behavior.content()
        : behavior.content;
    return new Response(content, { status: 200 });
  });
  const fetchHistoricalAttachment = vi.fn(
    async (
      input: Parameters<
        HistoricalAttachmentFetcher['fetchHistoricalAttachment']
      >[0],
    ): Promise<HistoricalAttachmentFetchResult> =>
      fetchSlackHistoricalAttachment(input, { filesInfo, download }),
  );
  return {
    fetcher: { fetchHistoricalAttachment },
    fetchHistoricalAttachment,
    filesInfo,
    download,
  };
}

function message(input: {
  id: string;
  conversationJid: string;
  attachments: NonNullable<NewMessage['attachments']>;
  threadId?: string;
}): NewMessage {
  return {
    id: input.id,
    chat_jid: input.conversationJid,
    provider: 'slack',
    providerAccountId,
    sender: 'U_FILE_1A',
    sender_name: 'File Owner',
    content: `attachments for ${input.id}`,
    timestamp: '2026-07-31T00:00:00.000Z',
    external_message_id: input.id,
    ...(input.threadId ? { thread_id: input.threadId } : {}),
    attachments: input.attachments,
  };
}

function slackAttachment(input: {
  attachmentId: string;
  fileId: string;
  fileName?: string;
  storageRef?: string;
}): NonNullable<NewMessage['attachments']>[number] {
  return {
    id: input.attachmentId,
    kind: 'file',
    externalId: input.fileId,
    ...(input.fileName ? { file_name: input.fileName } : {}),
    ...(input.storageRef ? { storageRef: input.storageRef } : {}),
    provider_fetch: {
      provider: 'slack',
      kind: 'file_id',
      id: input.fileId,
    },
  };
}

function createPostgresSeam(
  runtime: PostgresIntegrationRuntime,
  root: string,
  fetcher: HistoricalAttachmentFetcher,
) {
  const reclaim = (storageRef: string) =>
    removeProviderAttachment({
      materializationRoot: root,
      workspaceRoots,
      storageRef,
    });
  const messages = new CanonicalMessageOpsService(
    new PostgresCanonicalMessageRepository(runtime.service.db, 100, reclaim),
  );
  const attachments = new PostgresMessageAttachmentRepository(
    runtime.service.db,
    reclaim,
  );
  const writer = vi.fn(writeInboundAttachment);
  const resolver = new AttachmentResolver({
    repository: attachments,
    fetcher,
    materializationRoot: root,
    workspaceRoots: () => workspaceRoots,
    writeAttachment: writer,
  });
  return { attachments, messages, resolver, writer };
}

function openRequest(
  attachmentId: string,
  conversationJid: string,
  threadId?: string,
): Parameters<AttachmentResolver['open']>[0] {
  return {
    attachmentId,
    appId,
    providerAccountId,
    conversationJid,
    ...(threadId ? { threadId } : {}),
  };
}

function regularFiles(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .flatMap((entry) =>
      entry.isFile() ? [path.join(entry.parentPath, entry.name)] : [],
    );
}

function overCapSlackStream(): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let chunks = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks > ATTACHMENT_MAX_BYTES / chunk.byteLength) {
        controller.close();
        return;
      }
      chunks += 1;
      controller.enqueue(chunk);
    },
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

maybeDescribe('attachment resolver with Postgres repositories', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'attachment_resolver',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('hides a foreign conversation and resolves a thread in the owning conversation', async () => {
    const root = materializationRoot('scope');
    const slack = fakeSlackFetcher({
      F_SCOPE: {
        status: 'ok',
        content: Buffer.from('same-conversation bytes'),
        fileName: 'scope.txt',
        contentType: 'text/plain',
      },
    });
    const seam = createPostgresSeam(runtime, root, slack.fetcher);
    const attachmentId = 'attachment:file-1a:scope';
    const owningConversation = 'sl:C_FILE_1A_SCOPE_A';
    const owningThread = '1712345678.000001';
    await seam.messages.storeMessage(
      message({
        id: 'message-file-1a-scope',
        conversationJid: owningConversation,
        threadId: owningThread,
        attachments: [slackAttachment({ attachmentId, fileId: 'F_SCOPE' })],
      }),
    );
    await seam.messages.storeMessage(
      message({
        id: 'message-file-1a-foreign-scope',
        conversationJid: 'sl:C_FILE_1A_SCOPE_B',
        attachments: [],
      }),
    );

    await expect(
      seam.resolver.open(openRequest(attachmentId, 'sl:C_FILE_1A_SCOPE_B')),
    ).resolves.toEqual({
      status: 'not_found',
      content: ATTACHMENT_NOT_FOUND_COPY,
    });

    const opened = await seam.resolver.open(
      openRequest(attachmentId, owningConversation, owningThread),
    );
    expect(opened).toMatchObject({
      status: 'opened',
      content: 'same-conversation bytes',
    });
    expect(slack.fetchHistoricalAttachment).toHaveBeenCalledOnce();
    expect(slack.fetchHistoricalAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: owningThread }),
    );
    expect(slack.filesInfo).toHaveBeenCalledOnce();
    expect(slack.download).toHaveBeenCalledOnce();
  });

  it('persists lazy fetches and single-flights two concurrent opens', async () => {
    const root = materializationRoot('lazy');
    const slack = fakeSlackFetcher({
      F_SEQUENTIAL: {
        status: 'ok',
        content: Buffer.from('persisted sequential bytes'),
        fileName: 'sequential.txt',
        contentType: 'text/plain',
      },
      F_CONCURRENT: {
        status: 'ok',
        content: Buffer.from('single-flight bytes'),
        fileName: 'concurrent.txt',
        contentType: 'text/plain',
      },
    });
    const seam = createPostgresSeam(runtime, root, slack.fetcher);
    const conversationJid = 'sl:C_FILE_1A_LAZY';
    const sequentialId = 'attachment:file-1a:sequential';
    const concurrentId = 'attachment:file-1a:concurrent';
    await seam.messages.storeMessage(
      message({
        id: 'message-file-1a-lazy',
        conversationJid,
        attachments: [
          slackAttachment({
            attachmentId: sequentialId,
            fileId: 'F_SEQUENTIAL',
          }),
          slackAttachment({
            attachmentId: concurrentId,
            fileId: 'F_CONCURRENT',
          }),
        ],
      }),
    );

    const first = await seam.resolver.open(
      openRequest(sequentialId, conversationJid),
    );
    const second = await seam.resolver.open(
      openRequest(sequentialId, conversationJid),
    );
    expect(first).toMatchObject({
      status: 'opened',
      content: 'persisted sequential bytes',
    });
    expect(second).toEqual(first);
    expect(
      slack.fetchHistoricalAttachment.mock.calls.filter(
        ([input]) => input.identity.id === 'F_SEQUENTIAL',
      ),
    ).toHaveLength(1);
    const sequentialRow =
      await seam.attachments.getResolvableAttachment(sequentialId);
    expect(sequentialRow?.storageRef).toBe(
      first.status === 'opened' ? first.storageRef : undefined,
    );
    expect(
      first.status === 'opened' &&
        fs.readFileSync(first.materializedPath, 'utf8'),
    ).toBe('persisted sequential bytes');
    expect(
      first.status === 'opened' &&
        path.relative(workspaceRoots[0]!, first.materializedPath),
    ).toMatch(/^\.\./);

    const [concurrentFirst, concurrentSecond] = await Promise.all([
      seam.resolver.open(openRequest(concurrentId, conversationJid)),
      seam.resolver.open(openRequest(concurrentId, conversationJid)),
    ]);
    expect(concurrentFirst).toMatchObject({
      status: 'opened',
      content: 'single-flight bytes',
    });
    expect(concurrentSecond).toEqual(concurrentFirst);
    expect(
      slack.fetchHistoricalAttachment.mock.calls.filter(
        ([input]) => input.identity.id === 'F_CONCURRENT',
      ),
    ).toHaveLength(1);
    expect(seam.writer).toHaveBeenCalledTimes(2);
  });

  it('refuses a Slack stream over 50 MiB without changing the row or leaving a file', async () => {
    const root = materializationRoot('cap');
    const slack = fakeSlackFetcher({
      F_TOO_LARGE: {
        status: 'ok',
        content: overCapSlackStream,
        fileName: 'too-large.bin',
        contentType: 'application/octet-stream',
      },
    });
    const seam = createPostgresSeam(runtime, root, slack.fetcher);
    const attachmentId = 'attachment:file-1a:too-large';
    const conversationJid = 'sl:C_FILE_1A_CAP';
    await seam.messages.storeMessage(
      message({
        id: 'message-file-1a-cap',
        conversationJid,
        attachments: [slackAttachment({ attachmentId, fileId: 'F_TOO_LARGE' })],
      }),
    );
    const before = await seam.attachments.getResolvableAttachment(attachmentId);

    await expect(
      seam.resolver.open(openRequest(attachmentId, conversationJid)),
    ).resolves.toEqual({
      status: 'too_large',
      content: ATTACHMENT_TOO_LARGE_COPY,
    });

    await expect(
      seam.attachments.getResolvableAttachment(attachmentId),
    ).resolves.toEqual(before);
    expect(seam.writer).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: ATTACHMENT_MAX_BYTES }),
    );
    expect(regularFiles(root)).toEqual([]);
  });

  it('tombstones only file_deleted and never calls Slack again for the tombstone', async () => {
    const root = materializationRoot('tombstone');
    const slack = fakeSlackFetcher({
      F_DELETED: { status: 'deleted' },
      F_NOT_FOUND: { status: 'not_found' },
    });
    const seam = createPostgresSeam(runtime, root, slack.fetcher);
    const conversationJid = 'sl:C_FILE_1A_TOMBSTONE';
    const deletedId = 'attachment:file-1a:deleted';
    const notFoundId = 'attachment:file-1a:not-found';
    await seam.messages.storeMessage(
      message({
        id: 'message-file-1a-tombstone',
        conversationJid,
        attachments: [
          slackAttachment({ attachmentId: deletedId, fileId: 'F_DELETED' }),
          slackAttachment({
            attachmentId: notFoundId,
            fileId: 'F_NOT_FOUND',
          }),
        ],
      }),
    );

    await expect(
      seam.resolver.open(openRequest(deletedId, conversationJid)),
    ).resolves.toEqual({
      status: 'deleted',
      content: ATTACHMENT_DELETED_COPY,
    });
    expect(
      (await seam.attachments.getResolvableAttachment(deletedId))?.deletedAt,
    ).toBeTruthy();
    await expect(
      seam.resolver.open(openRequest(deletedId, conversationJid)),
    ).resolves.toEqual({
      status: 'deleted',
      content: ATTACHMENT_DELETED_COPY,
    });
    expect(
      slack.fetchHistoricalAttachment.mock.calls.filter(
        ([input]) => input.identity.id === 'F_DELETED',
      ),
    ).toHaveLength(1);

    await expect(
      seam.resolver.open(openRequest(notFoundId, conversationJid)),
    ).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
    expect(
      (await seam.attachments.getResolvableAttachment(notFoundId))?.deletedAt,
    ).toBeUndefined();
  });

  it('reclaims a dropped materialization after redelivery and preserves the retained one', async () => {
    const root = materializationRoot('redelivery');
    const slack = fakeSlackFetcher({
      F_DROP: {
        status: 'ok',
        content: Buffer.from('bytes to reclaim'),
        fileName: 'drop.txt',
        contentType: 'text/plain',
      },
      F_KEEP: {
        status: 'ok',
        content: Buffer.from('bytes to preserve'),
        fileName: 'keep.txt',
        contentType: 'text/plain',
      },
    });
    const seam = createPostgresSeam(runtime, root, slack.fetcher);
    const conversationJid = 'sl:C_FILE_1A_REDELIVERY';
    const droppedId = 'attachment:file-1a:drop';
    const keptId = 'attachment:file-1a:keep';
    const original = message({
      id: 'message-file-1a-redelivery',
      conversationJid,
      attachments: [
        slackAttachment({ attachmentId: droppedId, fileId: 'F_DROP' }),
        slackAttachment({ attachmentId: keptId, fileId: 'F_KEEP' }),
      ],
    });
    await seam.messages.storeMessage(original);
    const dropped = await seam.resolver.open(
      openRequest(droppedId, conversationJid),
    );
    const kept = await seam.resolver.open(openRequest(keptId, conversationJid));
    expect(dropped.status).toBe('opened');
    expect(kept.status).toBe('opened');
    if (dropped.status !== 'opened' || kept.status !== 'opened') {
      throw new Error('Expected both fixtures to materialize');
    }

    await seam.messages.storeMessage({
      ...original,
      content: 'redelivered with one attachment',
      attachments: [
        {
          id: keptId,
          kind: 'file',
          externalId: 'F_KEEP',
        },
      ],
    });

    await expect(
      seam.attachments.getResolvableAttachment(droppedId),
    ).resolves.toBeNull();
    expect(fs.existsSync(dropped.materializedPath)).toBe(false);
    await expect(
      seam.attachments.getResolvableAttachment(keptId),
    ).resolves.toMatchObject({
      storageRef: kept.storageRef,
      providerFetch: {
        provider: 'slack',
        kind: 'file_id',
        id: 'F_KEEP',
      },
    });
    expect(fs.readFileSync(kept.materializedPath, 'utf8')).toBe(
      'bytes to preserve',
    );
  });

  it('drops a resurrected stale provider ref and re-fetches from the preserved identity', async () => {
    const root = materializationRoot('resurrection');
    const slack = fakeSlackFetcher({
      F_RESURRECT: {
        status: 'ok',
        content: Buffer.from('freshly fetched bytes'),
        fileName: 'resurrect.txt',
        contentType: 'text/plain',
      },
    });
    const seam = createPostgresSeam(runtime, root, slack.fetcher);
    const conversationJid = 'sl:C_FILE_1A_RESURRECTION';
    const attachmentId = 'attachment:file-1a:resurrection';
    const original = message({
      id: 'message-file-1a-resurrection',
      conversationJid,
      attachments: [slackAttachment({ attachmentId, fileId: 'F_RESURRECT' })],
    });
    await seam.messages.storeMessage(original);
    const initial = await seam.resolver.open(
      openRequest(attachmentId, conversationJid),
    );
    expect(initial.status).toBe('opened');
    if (initial.status !== 'opened') {
      throw new Error('Expected the fixture to materialize');
    }

    await seam.messages.storeMessage({ ...original, attachments: [] });
    expect(fs.existsSync(initial.materializedPath)).toBe(false);
    await seam.messages.storeMessage({
      ...original,
      attachments: [
        slackAttachment({
          attachmentId,
          fileId: 'F_RESURRECT',
          storageRef: initial.storageRef,
        }),
      ],
    });

    const resurrected =
      await seam.attachments.getResolvableAttachment(attachmentId);
    expect(resurrected?.storageRef).toBeUndefined();
    expect(resurrected).toMatchObject({
      providerFetch: {
        provider: 'slack',
        kind: 'file_id',
        id: 'F_RESURRECT',
      },
    });
    const reopened = await seam.resolver.open(
      openRequest(attachmentId, conversationJid),
    );
    expect(reopened).toMatchObject({
      status: 'opened',
      content: 'freshly fetched bytes',
    });
    expect(reopened.status === 'opened' && reopened.storageRef).not.toBe(
      initial.storageRef,
    );
    expect(slack.fetchHistoricalAttachment).toHaveBeenCalledTimes(2);
  });
});
