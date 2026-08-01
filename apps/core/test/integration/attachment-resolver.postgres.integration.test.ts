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
import { fetchDiscordHistoricalAttachment } from '@core/channels/discord-historical-attachment-fetcher.js';
import { DiscordRestError } from '@core/channels/discord-http-helpers.js';
import { routeDiscordDeletion } from '@core/channels/discord-message-deletion.js';
import { createChannelAttachmentDeletionHandler } from '@core/app/bootstrap/channel-wiring-attachment-deletion.js';
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
const discordProviderAccountId = 'discord_file_1b_postgres';
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
  provider?: string;
  providerAccountId?: string;
  externalMessageId?: string;
}): NewMessage {
  return {
    id: input.id,
    chat_jid: input.conversationJid,
    provider: input.provider ?? 'slack',
    providerAccountId: input.providerAccountId ?? providerAccountId,
    sender: 'U_FILE_1A',
    sender_name: 'File Owner',
    content: `attachments for ${input.id}`,
    timestamp: '2026-07-31T00:00:00.000Z',
    external_message_id: input.externalMessageId ?? input.id,
    ...(input.threadId ? { thread_id: input.threadId } : {}),
    attachments: input.attachments,
  };
}

function discordAttachment(input: {
  attachmentId: string;
  discordAttachmentId: string;
  channelId: string;
  messageId: string;
  parentChannelId?: string;
  fileName?: string;
}): NonNullable<NewMessage['attachments']>[number] {
  return {
    id: input.attachmentId,
    kind: 'file',
    externalId: input.discordAttachmentId,
    ...(input.fileName ? { file_name: input.fileName } : {}),
    provider_fetch: {
      provider: 'discord',
      kind: 'attachment_id',
      id: input.discordAttachmentId,
      channelId: input.channelId,
      messageId: input.messageId,
      ...(input.parentChannelId
        ? { parentChannelId: input.parentChannelId }
        : {}),
      url: 'https://cdn.discordapp.com/attachments/expired/copy.bin',
    },
  };
}

function fakeDiscordFetcher(input: {
  status?: 'ok' | 'deleted';
  content?: Uint8Array | (() => ReadableStream<Uint8Array>);
  fileName?: string;
  contentType?: string;
}) {
  const requestMessage = vi.fn(async (channelId: string, messageId: string) => {
    if (input.status === 'deleted') {
      throw new DiscordRestError('unknown message', 404, 10008);
    }
    return {
      id: messageId,
      channel_id: channelId,
      attachments: [
        {
          id: 'discord-file',
          filename: input.fileName,
          content_type: input.contentType,
          url: 'https://cdn.discordapp.com/attachments/fresh/copy.bin',
        },
      ],
    };
  });
  const download = vi.fn(async () => {
    const content =
      typeof input.content === 'function' ? input.content() : input.content;
    return new Response(content ?? new Uint8Array());
  });
  const fetchHistoricalAttachment = vi.fn(
    async (
      request: Parameters<
        HistoricalAttachmentFetcher['fetchHistoricalAttachment']
      >[0],
    ) =>
      fetchDiscordHistoricalAttachment(request, { requestMessage, download }),
  );
  return {
    fetcher: { fetchHistoricalAttachment },
    fetchHistoricalAttachment,
    requestMessage,
    download,
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
  accountId = providerAccountId,
): Parameters<AttachmentResolver['open']>[0] {
  return {
    attachmentId,
    appId,
    providerAccountId: accountId,
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

  it('backfills a pre-0117 Slack file id and lazily opens it without touching another provider', async () => {
    const root = materializationRoot('migration-backfill');
    const slack = fakeSlackFetcher({
      F_MIGRATION_BACKFILL: {
        status: 'ok',
        content: Buffer.from('backfilled migration bytes'),
        fileName: 'backfilled.txt',
        contentType: 'text/plain',
      },
    });
    const seam = createPostgresSeam(runtime, root, slack.fetcher);
    const conversationJid = 'sl:C_FILE_1A_MIGRATION_BACKFILL';
    const attachmentId = 'attachment:file-1a:migration-backfill';
    const untouchedAttachmentId =
      'attachment:file-1a:migration-backfill-non-slack';
    await seam.messages.storeMessage(
      message({
        id: 'message-file-1a-migration-backfill',
        conversationJid,
        attachments: [
          {
            id: attachmentId,
            kind: 'file',
            externalId: 'F_MIGRATION_BACKFILL',
            file_name: 'backfilled.txt',
          },
        ],
      }),
    );
    await seam.messages.storeMessage(
      message({
        id: 'message-file-1a-migration-backfill-non-slack',
        conversationJid: 'sl:C_FILE_1A_MIGRATION_BACKFILL_NON_SLACK',
        attachments: [
          {
            id: untouchedAttachmentId,
            kind: 'file',
            externalId: 'F_NON_SLACK',
          },
        ],
      }),
    );
    const untouchedBefore = await seam.attachments.getResolvableAttachment(
      untouchedAttachmentId,
    );
    if (!untouchedBefore) {
      throw new Error('Expected the non-Slack migration fixture');
    }
    expect(untouchedBefore.providerFetch).toBeUndefined();
    await runtime.service.pool.query(
      'UPDATE messages SET provider = $1 WHERE id = $2',
      ['telegram', untouchedBefore.messageId],
    );
    const slackBefore =
      await seam.attachments.getResolvableAttachment(attachmentId);
    expect(slackBefore?.storageRef).toBeUndefined();
    expect(slackBefore?.providerFetch).toBeUndefined();

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0117_message_attachment_metadata.sql',
      ),
      'utf8',
    );
    await runtime.service.pool.query(migration);

    await expect(
      seam.attachments.getResolvableAttachment(attachmentId),
    ).resolves.toMatchObject({
      providerFetch: {
        provider: 'slack',
        kind: 'file_id',
        id: 'F_MIGRATION_BACKFILL',
      },
    });
    expect(
      (await seam.attachments.getResolvableAttachment(untouchedAttachmentId))
        ?.providerFetch,
    ).toBeUndefined();
    await expect(
      seam.resolver.open(openRequest(attachmentId, conversationJid)),
    ).resolves.toMatchObject({
      status: 'opened',
      content: 'backfilled migration bytes',
    });
    expect(slack.filesInfo).toHaveBeenCalledOnce();
    expect(slack.download).toHaveBeenCalledOnce();
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

  it('scope-fences a Discord lazy fetch and persists fresh provider metadata', async () => {
    const root = materializationRoot('discord-lazy');
    const discord = fakeDiscordFetcher({
      content: Buffer.from('discord historical bytes'),
      fileName: 'discord-report.txt',
      contentType: 'text/plain',
    });
    const seam = createPostgresSeam(runtime, root, discord.fetcher);
    const conversationJid = 'dc:discord-channel';
    const attachmentId = 'attachment:file-1b:discord-lazy';
    await seam.messages.storeMessage(
      message({
        id: 'discord-message',
        conversationJid,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId,
            discordAttachmentId: 'discord-file',
            channelId: 'discord-channel',
            messageId: 'discord-message',
          }),
        ],
      }),
    );

    await expect(
      seam.resolver.open(
        openRequest(
          attachmentId,
          'dc:foreign-channel',
          undefined,
          discordProviderAccountId,
        ),
      ),
    ).resolves.toEqual({
      status: 'not_found',
      content: ATTACHMENT_NOT_FOUND_COPY,
    });
    expect(discord.requestMessage).not.toHaveBeenCalled();

    const opened = await seam.resolver.open(
      openRequest(
        attachmentId,
        conversationJid,
        undefined,
        discordProviderAccountId,
      ),
    );
    expect(opened).toMatchObject({
      status: 'opened',
      content: 'discord historical bytes',
    });
    await expect(
      seam.attachments.getResolvableAttachment(attachmentId),
    ).resolves.toMatchObject({
      fileName: 'discord-report.txt',
      contentType: 'text/plain',
      storageRef: expect.stringMatching(/^provider-attachments\//),
    });
    expect(discord.requestMessage).toHaveBeenCalledOnce();
    expect(discord.download).toHaveBeenCalledWith(
      'https://cdn.discordapp.com/attachments/fresh/copy.bin',
      expect.any(AbortSignal),
    );
  });

  it('leaves a Discord row unchanged when actual streamed bytes exceed 50 MiB', async () => {
    const root = materializationRoot('discord-cap');
    const discord = fakeDiscordFetcher({
      content: overCapSlackStream,
      fileName: 'discord-too-large.bin',
      contentType: 'application/octet-stream',
    });
    const seam = createPostgresSeam(runtime, root, discord.fetcher);
    const conversationJid = 'dc:discord-cap-channel';
    const attachmentId = 'attachment:file-1b:discord-cap';
    await seam.messages.storeMessage(
      message({
        id: 'discord-cap-message',
        conversationJid,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId,
            discordAttachmentId: 'discord-file',
            channelId: 'discord-cap-channel',
            messageId: 'discord-cap-message',
          }),
        ],
      }),
    );
    const before = await seam.attachments.getResolvableAttachment(attachmentId);

    await expect(
      seam.resolver.open(
        openRequest(
          attachmentId,
          conversationJid,
          undefined,
          discordProviderAccountId,
        ),
      ),
    ).resolves.toEqual({
      status: 'too_large',
      content: ATTACHMENT_TOO_LARGE_COPY,
    });
    await expect(
      seam.attachments.getResolvableAttachment(attachmentId),
    ).resolves.toEqual(before);
    expect(regularFiles(root)).toEqual([]);
  });

  it('tombstones an explicitly deleted Discord message and never fetches it again', async () => {
    const root = materializationRoot('discord-deleted');
    const discord = fakeDiscordFetcher({ status: 'deleted' });
    const seam = createPostgresSeam(runtime, root, discord.fetcher);
    const conversationJid = 'dc:discord-deleted-channel';
    const attachmentId = 'attachment:file-1b:discord-deleted';
    await seam.messages.storeMessage(
      message({
        id: 'discord-deleted-message',
        conversationJid,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId,
            discordAttachmentId: 'discord-file',
            channelId: 'discord-deleted-channel',
            messageId: 'discord-deleted-message',
          }),
        ],
      }),
    );
    const request = openRequest(
      attachmentId,
      conversationJid,
      undefined,
      discordProviderAccountId,
    );

    await expect(seam.resolver.open(request)).resolves.toEqual({
      status: 'deleted',
      content: ATTACHMENT_DELETED_COPY,
    });
    await expect(seam.resolver.open(request)).resolves.toEqual({
      status: 'deleted',
      content: ATTACHMENT_DELETED_COPY,
    });
    expect(discord.requestMessage).toHaveBeenCalledOnce();
    expect(
      (await seam.attachments.getResolvableAttachment(attachmentId))?.deletedAt,
    ).toBeTruthy();
  });

  it('atomically tombstones only the scoped Discord deletion event and reclaims bytes after commit', async () => {
    const root = materializationRoot('discord-deletion-event');
    const discord = fakeDiscordFetcher({
      content: Buffer.from('provider bytes'),
      fileName: 'deleted.txt',
      contentType: 'text/plain',
    });
    const seam = createPostgresSeam(runtime, root, discord.fetcher);
    const conversationJid = 'dc:discord-deletion-channel';
    const targetId = 'attachment:file-1b:event-target';
    const siblingId = 'attachment:file-1b:event-sibling';
    const legacyIdentitylessId = 'attachment:file-1b:event-legacy';
    const foreignIdentityId = 'attachment:file-1b:event-foreign-provider';
    const foreignConversationId =
      'attachment:file-1b:event-foreign-conversation';
    const targetMessage = message({
      id: 'discord-deletion-message',
      conversationJid,
      provider: 'discord',
      providerAccountId: discordProviderAccountId,
      attachments: [
        discordAttachment({
          attachmentId: targetId,
          discordAttachmentId: 'discord-file',
          channelId: 'discord-deletion-channel',
          messageId: 'discord-deletion-message',
        }),
        discordAttachment({
          attachmentId: siblingId,
          discordAttachmentId: 'discord-sibling',
          channelId: 'discord-deletion-channel',
          messageId: 'discord-deletion-message',
        }),
        slackAttachment({
          attachmentId: foreignIdentityId,
          fileId: 'F_FOREIGN_PROVIDER',
        }),
        {
          id: legacyIdentitylessId,
          kind: 'file',
          externalId: 'discord-legacy-file',
        },
      ],
    });
    await seam.messages.storeMessage(targetMessage);
    await seam.messages.storeMessage(
      message({
        id: 'discord-deletion-message',
        conversationJid: 'dc:discord-foreign-channel',
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId: foreignConversationId,
            discordAttachmentId: 'discord-file',
            channelId: 'discord-foreign-channel',
            messageId: 'discord-deletion-message',
          }),
        ],
      }),
    );
    const request = openRequest(
      targetId,
      conversationJid,
      undefined,
      discordProviderAccountId,
    );
    await expect(seam.resolver.open(request)).resolves.toMatchObject({
      status: 'opened',
    });
    expect(regularFiles(root)).toHaveLength(1);
    const providerCallsBeforeDeletion =
      discord.requestMessage.mock.calls.length;

    await expect(
      seam.attachments.setDeletedAtByMessageExternalIds({
        appId: 'foreign-app',
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId: conversationJid,
        externalMessageIds: ['discord-deletion-message'],
        deletedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).resolves.toEqual({ tombstonedAttachments: [] });
    await expect(
      seam.attachments.setDeletedAtByMessageExternalIds({
        appId,
        providerId: 'discord',
        providerAccountIds: ['foreign-provider-account'],
        channelId: conversationJid,
        externalMessageIds: ['discord-deletion-message'],
        deletedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).resolves.toEqual({ tombstonedAttachments: [] });
    expect(
      (await seam.attachments.getResolvableAttachment(targetId))?.deletedAt,
    ).toBeUndefined();

    await expect(
      seam.attachments.setDeletedAtByMessageExternalIds({
        appId,
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId: conversationJid,
        externalMessageIds: [
          'discord-deletion-message',
          'discord-deletion-message',
          'unknown-message',
        ],
        deletedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      tombstonedAttachments: [legacyIdentitylessId, siblingId, targetId]
        .sort()
        .map((attachmentId) => ({
          attachmentId,
          deletedAt: '2026-08-01T00:00:00.000Z',
        })),
    });

    expect(regularFiles(root)).toEqual([]);
    await expect(seam.resolver.open(request)).resolves.toEqual({
      status: 'deleted',
      content: ATTACHMENT_DELETED_COPY,
    });
    expect(await seam.resolver.open(request)).not.toHaveProperty('gantryRef');
    expect(discord.requestMessage).toHaveBeenCalledTimes(
      providerCallsBeforeDeletion,
    );
    expect(
      (await seam.attachments.getResolvableAttachment(targetId))?.deletedAt,
    ).toBe('2026-08-01T00:00:00.000Z');
    expect(
      (await seam.attachments.getResolvableAttachment(siblingId))?.deletedAt,
    ).toBe('2026-08-01T00:00:00.000Z');
    expect(
      (await seam.attachments.getResolvableAttachment(legacyIdentitylessId))
        ?.deletedAt,
    ).toBe('2026-08-01T00:00:00.000Z');
    expect(
      (await seam.attachments.getResolvableAttachment(foreignIdentityId))
        ?.deletedAt,
    ).toBeUndefined();
    expect(
      (await seam.attachments.getResolvableAttachment(foreignConversationId))
        ?.deletedAt,
    ).toBeUndefined();

    await Promise.all([
      seam.attachments.setDeletedAtByMessageExternalIds({
        appId,
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId: conversationJid,
        externalMessageIds: ['discord-deletion-message'],
        deletedAt: '2026-08-01T00:00:01.000Z',
      }),
      seam.messages.storeMessage({
        ...targetMessage,
        content: 'concurrent redelivery',
      }),
    ]);
    expect(
      (await seam.attachments.getResolvableAttachment(targetId))?.deletedAt,
    ).toBe('2026-08-01T00:00:00.000Z');
    expect(
      (await seam.attachments.getResolvableAttachment(foreignIdentityId))
        ?.deletedAt,
    ).toBeUndefined();
  });

  it('retains the pair marker until a failed byte reclaim succeeds on retry', async () => {
    const root = materializationRoot('discord-deletion-reclaim-retry');
    const discord = fakeDiscordFetcher({
      content: Buffer.from('reclaim retry bytes'),
      fileName: 'reclaim-retry.txt',
    });
    const seam = createPostgresSeam(runtime, root, discord.fetcher);
    const channelId = 'discord-deletion-reclaim-retry';
    const conversationJid = `dc:${channelId}`;
    const messageId = 'discord-deletion-reclaim-retry-message';
    const attachmentId = 'attachment:file-1b:deletion-reclaim-retry';
    await seam.messages.storeMessage(
      message({
        id: messageId,
        conversationJid,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId,
            discordAttachmentId: 'discord-file',
            channelId,
            messageId,
          }),
        ],
      }),
    );
    await expect(
      seam.resolver.open(
        openRequest(
          attachmentId,
          conversationJid,
          undefined,
          discordProviderAccountId,
        ),
      ),
    ).resolves.toMatchObject({ status: 'opened' });
    expect(regularFiles(root)).toHaveLength(1);

    let reclaimCalls = 0;
    const repository = new PostgresMessageAttachmentRepository(
      runtime.service.db,
      async (storageRef) => {
        reclaimCalls += 1;
        if (reclaimCalls === 1) throw new Error('fail reclaim once');
        await removeProviderAttachment({
          materializationRoot: root,
          workspaceRoots,
          storageRef,
        });
      },
    );
    const deletion = {
      appId,
      providerId: 'discord',
      providerAccountIds: [discordProviderAccountId],
      channelId: conversationJid,
      externalMessageIds: [messageId],
      deletedAt: '2026-08-01T00:00:00.000Z',
    } as const;

    await expect(
      repository.setDeletedAtByMessageExternalIds(deletion),
    ).rejects.toThrow('fail reclaim once');
    await expect(
      runtime.service.pool.query(
        'SELECT external_message_id FROM message_attachment_deletion_markers WHERE provider_account_id = $1 AND external_message_id = $2',
        [discordProviderAccountId, messageId],
      ),
    ).resolves.toMatchObject({
      rows: [{ external_message_id: messageId }],
    });
    expect(regularFiles(root)).toHaveLength(1);

    await expect(
      repository.retryPendingMessageAttachmentDeletions(),
    ).resolves.toBe(false);
    await expect(
      runtime.service.pool.query(
        'SELECT external_message_id FROM message_attachment_deletion_markers WHERE provider_account_id = $1 AND external_message_id = $2',
        [discordProviderAccountId, messageId],
      ),
    ).resolves.toMatchObject({ rows: [] });
    expect(regularFiles(root)).toEqual([]);
    expect(reclaimCalls).toBe(2);
  });

  it('keeps a deletion marker until a later Discord message insert lands tombstoned', async () => {
    const root = materializationRoot('discord-delete-before-insert');
    const discord = fakeDiscordFetcher({
      content: Buffer.from('never fetched'),
    });
    const seam = createPostgresSeam(runtime, root, discord.fetcher);
    const conversationJid = 'dc:discord-delete-before-insert';
    const messageId = 'discord-delete-before-insert-message';
    const attachmentId = 'attachment:file-1b:delete-before-insert';

    await expect(
      seam.attachments.setDeletedAtByMessageExternalIds({
        appId,
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId: conversationJid,
        externalMessageIds: [messageId],
        deletedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).resolves.toEqual({ tombstonedAttachments: [] });

    await seam.messages.storeMessage(
      message({
        id: messageId,
        conversationJid,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId,
            discordAttachmentId: 'discord-late-file',
            channelId: 'discord-delete-before-insert',
            messageId,
          }),
        ],
      }),
    );

    expect(
      (await seam.attachments.getResolvableAttachment(attachmentId))?.deletedAt,
    ).toBe('2026-08-01T00:00:00.000Z');
    await expect(
      seam.resolver.open(
        openRequest(
          attachmentId,
          conversationJid,
          undefined,
          discordProviderAccountId,
        ),
      ),
    ).resolves.toEqual({ status: 'deleted', content: ATTACHMENT_DELETED_COPY });
    expect(discord.requestMessage).not.toHaveBeenCalled();
    await expect(
      seam.attachments.retryPendingMessageAttachmentDeletions(),
    ).resolves.toBe(false);
  });

  it('consumes only the persisted pair from a bulk deletion and retains the in-flight pair', async () => {
    const seam = createPostgresSeam(
      runtime,
      materializationRoot('discord-bulk-pair-grain'),
      fakeDiscordFetcher({ content: Buffer.from('unused') }).fetcher,
    );
    const channelId = 'discord-bulk-pair-channel';
    const persistedMessageId = 'discord-bulk-persisted';
    const inFlightMessageId = 'discord-bulk-in-flight';
    const persistedAttachmentId = 'attachment:file-1b:bulk-persisted';
    const inFlightAttachmentId = 'attachment:file-1b:bulk-in-flight';
    await seam.messages.storeMessage(
      message({
        id: persistedMessageId,
        conversationJid: `dc:${channelId}`,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId: persistedAttachmentId,
            discordAttachmentId: 'discord-bulk-file-1',
            channelId,
            messageId: persistedMessageId,
          }),
        ],
      }),
    );

    await seam.attachments.setDeletedAtByMessageExternalIds({
      appId,
      providerId: 'discord',
      providerAccountIds: [discordProviderAccountId],
      channelId: `dc:${channelId}`,
      externalMessageIds: [persistedMessageId, inFlightMessageId],
      deletedAt: '2026-08-01T00:00:00.000Z',
    });

    expect(
      (await seam.attachments.getResolvableAttachment(persistedAttachmentId))
        ?.deletedAt,
    ).toBe('2026-08-01T00:00:00.000Z');
    await expect(
      runtime.service.pool.query(
        'SELECT provider_account_id, external_message_id FROM message_attachment_deletion_markers WHERE channel_id = $1 ORDER BY external_message_id',
        [`dc:${channelId}`],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          provider_account_id: discordProviderAccountId,
          external_message_id: inFlightMessageId,
        },
      ],
    });

    await seam.messages.storeMessage(
      message({
        id: inFlightMessageId,
        conversationJid: `dc:${channelId}`,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId: inFlightAttachmentId,
            discordAttachmentId: 'discord-bulk-file-2',
            channelId,
            messageId: inFlightMessageId,
          }),
        ],
      }),
    );
    expect(
      (await seam.attachments.getResolvableAttachment(inFlightAttachmentId))
        ?.deletedAt,
    ).toBe('2026-08-01T00:00:00.000Z');
  });

  it('retains the second shared-credential account pair after the first account consumes its own', async () => {
    const seam = createPostgresSeam(
      runtime,
      materializationRoot('discord-shared-account-pair-grain'),
      fakeDiscordFetcher({ content: Buffer.from('unused') }).fetcher,
    );
    const channelId = 'discord-shared-account-channel';
    const externalMessageId = 'discord-shared-account-message';
    const secondAccountId = 'discord_file_1b_postgres_second';
    const firstAttachmentId = 'attachment:file-1b:shared-account-first';
    await seam.messages.storeMessage(
      message({
        id: 'discord-shared-account-first-row',
        externalMessageId,
        conversationJid: `dc:${channelId}`,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId: firstAttachmentId,
            discordAttachmentId: 'discord-shared-account-file-1',
            channelId,
            messageId: externalMessageId,
          }),
        ],
      }),
    );

    await seam.attachments.setDeletedAtByMessageExternalIds({
      appId,
      providerId: 'discord',
      providerAccountIds: [discordProviderAccountId, secondAccountId],
      channelId: `dc:${channelId}`,
      externalMessageIds: [externalMessageId],
      deletedAt: '2026-08-01T00:00:00.000Z',
    });

    expect(
      (await seam.attachments.getResolvableAttachment(firstAttachmentId))
        ?.deletedAt,
    ).toBe('2026-08-01T00:00:00.000Z');
    await expect(
      runtime.service.pool.query(
        'SELECT provider_account_id, external_message_id FROM message_attachment_deletion_markers WHERE external_message_id = $1',
        [externalMessageId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          provider_account_id: secondAccountId,
          external_message_id: externalMessageId,
        },
      ],
    });
  });

  it('retains a durable marker when tombstoning fails once and succeeds on retry', async () => {
    const root = materializationRoot('discord-deletion-retry');
    const discord = fakeDiscordFetcher({ content: Buffer.from('retry bytes') });
    const seam = createPostgresSeam(runtime, root, discord.fetcher);
    const conversationJid = 'dc:discord-deletion-retry';
    const messageId = 'discord-deletion-retry-message';
    const attachmentId = 'attachment:file-1b:deletion-retry';
    await seam.messages.storeMessage(
      message({
        id: messageId,
        conversationJid,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId,
            discordAttachmentId: 'discord-retry-file',
            channelId: 'discord-deletion-retry',
            messageId,
          }),
        ],
      }),
    );

    let transactionCalls = 0;
    const failOnceDb = new Proxy(runtime.service.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (...args: unknown[]) => {
            transactionCalls += 1;
            if (transactionCalls === 2) throw new Error('fail tombstone once');
            return (target.transaction as (...input: unknown[]) => unknown)(
              ...args,
            );
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failing = new PostgresMessageAttachmentRepository(
      failOnceDb as never,
    );
    await expect(
      failing.setDeletedAtByMessageExternalIds({
        appId,
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId: conversationJid,
        externalMessageIds: [messageId],
        deletedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('fail tombstone once');
    expect(
      (await seam.attachments.getResolvableAttachment(attachmentId))?.deletedAt,
    ).toBeUndefined();

    await expect(
      seam.attachments.retryPendingMessageAttachmentDeletions(),
    ).resolves.toBe(false);
    expect(
      (await seam.attachments.getResolvableAttachment(attachmentId))?.deletedAt,
    ).toBe('2026-08-01T00:00:00.000Z');
  });

  it('retains a raw deletion in process when the first marker insert fails', async () => {
    const seam = createPostgresSeam(
      runtime,
      materializationRoot('discord-raw-deletion-retry'),
      fakeDiscordFetcher({ content: Buffer.from('unused') }).fetcher,
    );
    const channelId = 'discord-raw-deletion-retry';
    const messageId = 'discord-raw-deletion-retry-message';
    const attachmentId = 'attachment:file-1b:raw-deletion-retry';
    await seam.messages.storeMessage(
      message({
        id: messageId,
        conversationJid: `dc:${channelId}`,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId,
            discordAttachmentId: 'discord-raw-retry-file',
            channelId,
            messageId,
          }),
        ],
      }),
    );

    let transactionCalls = 0;
    const failFirstInsertDb = new Proxy(runtime.service.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (...args: unknown[]) => {
            transactionCalls += 1;
            if (transactionCalls === 1) throw new Error('fail marker once');
            return (target.transaction as (...input: unknown[]) => unknown)(
              ...args,
            );
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const retryingRepository = new PostgresMessageAttachmentRepository(
      failFirstInsertDb as never,
    );
    const handler = createChannelAttachmentDeletionHandler(
      appId,
      () => retryingRepository,
      { retryDelayMs: 5 },
    );

    await expect(
      handler({
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId: `dc:${channelId}`,
        externalMessageIds: [messageId],
        deletedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('fail marker once');
    await vi.waitFor(async () => {
      expect(
        (await seam.attachments.getResolvableAttachment(attachmentId))
          ?.deletedAt,
      ).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  it('retries a failed raw deletion as one complete durable pair set', async () => {
    const messageIds = [
      'discord-raw-batch-retry-message-1',
      'discord-raw-batch-retry-message-2',
    ];
    let transactionCalls = 0;
    const failFirstInsertDb = new Proxy(runtime.service.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (...args: unknown[]) => {
            transactionCalls += 1;
            if (transactionCalls === 1) throw new Error('fail batch once');
            return (target.transaction as (...input: unknown[]) => unknown)(
              ...args,
            );
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const handler = createChannelAttachmentDeletionHandler(
      appId,
      () => new PostgresMessageAttachmentRepository(failFirstInsertDb as never),
      { retryDelayMs: 5 },
    );

    await expect(
      handler({
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId: 'dc:discord-raw-batch-retry',
        externalMessageIds: messageIds,
        deletedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('fail batch once');
    await vi.waitFor(async () => {
      await expect(
        runtime.service.pool.query(
          'SELECT external_message_id FROM message_attachment_deletion_markers WHERE provider_account_id = $1 AND external_message_id = ANY($2::text[]) ORDER BY external_message_id',
          [discordProviderAccountId, messageIds],
        ),
      ).resolves.toMatchObject({
        rows: messageIds.map((externalMessageId) => ({
          external_message_id: externalMessageId,
        })),
      });
    });
  });

  it('requires the exact Discord thread scope for deletion events', async () => {
    const root = materializationRoot('discord-deletion-thread');
    const discord = fakeDiscordFetcher({ content: Buffer.from('thread file') });
    const seam = createPostgresSeam(runtime, root, discord.fetcher);
    const conversationJid = 'dc:discord-thread-parent';
    const threadId = 'discord-thread-1';
    const attachmentId = 'attachment:file-1b:event-thread';
    await seam.messages.storeMessage(
      message({
        id: 'discord-thread-message',
        conversationJid,
        threadId,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId,
            discordAttachmentId: 'discord-file',
            channelId: threadId,
            parentChannelId: 'discord-thread-parent',
            messageId: 'discord-thread-message',
          }),
        ],
      }),
    );

    await expect(
      seam.attachments.setDeletedAtByMessageExternalIds({
        appId,
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId: conversationJid,
        externalMessageIds: ['discord-thread-message'],
        deletedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).resolves.toEqual({ tombstonedAttachments: [] });
    expect(
      (await seam.attachments.getResolvableAttachment(attachmentId))?.deletedAt,
    ).toBeUndefined();

    await expect(
      seam.attachments.setDeletedAtByMessageExternalIds({
        appId,
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId: threadId,
        externalMessageIds: ['discord-thread-message'],
        deletedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      tombstonedAttachments: [
        {
          attachmentId,
          deletedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('admits a cold-cache thread deletion from stored messages and rejects an unknown channel', async () => {
    const seam = createPostgresSeam(
      runtime,
      materializationRoot('discord-cold-cache-thread-deletion'),
      fakeDiscordFetcher({ content: Buffer.from('unused') }).fetcher,
    );
    const conversationJid = 'dc:discord-cold-cache-parent';
    const threadId = 'discord-cold-cache-thread';
    const messageId = 'discord-cold-cache-message';
    const attachmentId = 'attachment:file-1b:cold-cache-thread';
    await seam.messages.storeMessage(
      message({
        id: messageId,
        conversationJid,
        threadId,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId,
            discordAttachmentId: 'discord-cold-cache-file',
            channelId: threadId,
            parentChannelId: 'discord-cold-cache-parent',
            messageId,
          }),
        ],
      }),
    );
    const handler = createChannelAttachmentDeletionHandler(
      appId,
      () => seam.attachments,
      { retryDelayMs: 5 },
    );

    await routeDiscordDeletion(
      {
        t: 'MESSAGE_DELETE',
        d: { id: messageId, channel_id: threadId },
      },
      new Map(),
      {},
      [discordProviderAccountId],
      handler,
    );

    expect(
      (await seam.attachments.getResolvableAttachment(attachmentId))?.deletedAt,
    ).toBeDefined();

    await routeDiscordDeletion(
      {
        t: 'MESSAGE_DELETE',
        d: {
          id: 'discord-unknown-channel-message',
          channel_id: 'discord-unknown-channel',
        },
      },
      new Map(),
      {},
      [discordProviderAccountId],
      handler,
    );
    await expect(
      runtime.service.pool.query(
        'SELECT external_message_id FROM message_attachment_deletion_markers WHERE provider_account_id = $1 AND external_message_id = $2',
        [discordProviderAccountId, 'discord-unknown-channel-message'],
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it('admits the complete account scope from a mixed cold-cache bulk deletion', async () => {
    const seam = createPostgresSeam(
      runtime,
      materializationRoot('discord-cold-cache-pair-admission'),
      fakeDiscordFetcher({ content: Buffer.from('unused') }).fetcher,
    );
    const channelId = 'discord-cold-cache-pair-channel';
    const storedMessageId = 'discord-cold-cache-pair-stored';
    const unknownMessageId = 'discord-cold-cache-pair-unknown';
    await seam.messages.storeMessage(
      message({
        id: storedMessageId,
        conversationJid: `dc:${channelId}`,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [],
      }),
    );
    let transactionCalls = 0;
    const stopAfterMarkerInsertDb = new Proxy(runtime.service.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (...args: unknown[]) => {
            transactionCalls += 1;
            if (transactionCalls === 2) {
              throw new Error('stop after admitted marker insert');
            }
            return (target.transaction as (...input: unknown[]) => unknown)(
              ...args,
            );
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repository = new PostgresMessageAttachmentRepository(
      stopAfterMarkerInsertDb as never,
    );

    await expect(
      repository.setDeletedAtByMessageExternalIds({
        appId,
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId,
        fallbackConversationJid: `dc:${channelId}`,
        requireStoredMessageMatch: true,
        externalMessageIds: [storedMessageId, unknownMessageId],
        deletedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('stop after admitted marker insert');
    await expect(
      runtime.service.pool.query(
        'SELECT external_message_id FROM message_attachment_deletion_markers WHERE provider_account_id = $1 AND external_message_id = ANY($2::text[]) ORDER BY external_message_id',
        [discordProviderAccountId, [storedMessageId, unknownMessageId]],
      ),
    ).resolves.toMatchObject({
      rows: [
        { external_message_id: storedMessageId },
        { external_message_id: unknownMessageId },
      ],
    });
  });

  it('keeps same-message deletion markers independent across channels', async () => {
    const seam = createPostgresSeam(
      runtime,
      materializationRoot('discord-channel-scoped-markers'),
      fakeDiscordFetcher({ content: Buffer.from('unused') }).fetcher,
    );
    const externalMessageId = 'discord-shared-external-message';
    const channels = ['discord-scope-channel-1', 'discord-scope-channel-2'];

    for (const channelId of channels) {
      await seam.attachments.setDeletedAtByMessageExternalIds({
        appId,
        providerId: 'discord',
        providerAccountIds: [discordProviderAccountId],
        channelId: `dc:${channelId}`,
        externalMessageIds: [externalMessageId],
        deletedAt: '2026-08-01T00:00:00.000Z',
      });
    }
    await expect(
      runtime.service.pool.query(
        'SELECT channel_id FROM message_attachment_deletion_markers WHERE provider_account_id = $1 AND external_message_id = $2 ORDER BY channel_id',
        [discordProviderAccountId, externalMessageId],
      ),
    ).resolves.toMatchObject({
      rows: channels.map((channelId) => ({ channel_id: `dc:${channelId}` })),
    });

    for (const [index, channelId] of channels.entries()) {
      await seam.messages.storeMessage(
        message({
          id: `discord-channel-scoped-row-${index}`,
          externalMessageId,
          conversationJid: `dc:${channelId}`,
          provider: 'discord',
          providerAccountId: discordProviderAccountId,
          attachments: [
            discordAttachment({
              attachmentId: `attachment:file-1b:channel-scoped-${index}`,
              discordAttachmentId: `discord-channel-scoped-file-${index}`,
              channelId,
              messageId: externalMessageId,
            }),
          ],
        }),
      );
      expect(
        (
          await seam.attachments.getResolvableAttachment(
            `attachment:file-1b:channel-scoped-${index}`,
          )
        )?.deletedAt,
      ).toBe('2026-08-01T00:00:00.000Z');
    }
    await expect(
      runtime.service.pool.query(
        'SELECT id FROM message_attachment_deletion_markers WHERE provider_account_id = $1 AND external_message_id = $2',
        [discordProviderAccountId, externalMessageId],
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it('prefers the exact thread over a same-external-id unthreaded fallback', async () => {
    const seam = createPostgresSeam(
      runtime,
      materializationRoot('discord-unthreaded-fallback-match'),
      fakeDiscordFetcher({ content: Buffer.from('unused') }).fetcher,
    );
    const conversationJid = 'dc:discord-fallback-parent';
    const threadId = 'discord-fallback-thread';
    const externalMessageId = 'discord-fallback-shared-message';
    const parentAttachmentId = 'attachment:file-1b:fallback-parent';
    const threadAttachmentId = 'attachment:file-1b:fallback-thread';
    await seam.messages.storeMessage(
      message({
        id: 'discord-fallback-parent-row',
        externalMessageId,
        conversationJid,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId: parentAttachmentId,
            discordAttachmentId: 'discord-fallback-parent-file',
            channelId: 'discord-fallback-parent',
            messageId: externalMessageId,
          }),
        ],
      }),
    );
    await seam.messages.storeMessage(
      message({
        id: 'discord-fallback-thread-row',
        externalMessageId,
        conversationJid,
        threadId,
        provider: 'discord',
        providerAccountId: discordProviderAccountId,
        attachments: [
          discordAttachment({
            attachmentId: threadAttachmentId,
            discordAttachmentId: 'discord-fallback-thread-file',
            channelId: threadId,
            parentChannelId: 'discord-fallback-parent',
            messageId: externalMessageId,
          }),
        ],
      }),
    );

    await seam.attachments.setDeletedAtByMessageExternalIds({
      appId,
      providerId: 'discord',
      providerAccountIds: [discordProviderAccountId],
      channelId: threadId,
      fallbackConversationJid: conversationJid,
      requireStoredMessageMatch: true,
      externalMessageIds: [externalMessageId],
      deletedAt: '2026-08-01T00:00:00.000Z',
    });

    expect(
      (await seam.attachments.getResolvableAttachment(threadAttachmentId))
        ?.deletedAt,
    ).toBe('2026-08-01T00:00:00.000Z');
    expect(
      (await seam.attachments.getResolvableAttachment(parentAttachmentId))
        ?.deletedAt,
    ).toBeUndefined();
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
