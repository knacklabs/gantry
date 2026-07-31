import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ATTACHMENT_DELETED_COPY,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NOT_FOUND_COPY,
  ATTACHMENT_TOO_LARGE_COPY,
  ATTACHMENT_UNREACHABLE_COPY,
  AttachmentResolver,
} from '@core/application/attachments/attachment-resolver.js';
import type {
  HistoricalAttachmentFetchResult,
  HistoricalAttachmentFetcher,
} from '@core/domain/ports/historical-attachment-fetcher.js';
import type {
  MessageAttachmentRepository,
  ResolvableMessageAttachment,
} from '@core/domain/ports/message-attachment-repository.js';
import { writeInboundAttachment } from '@core/shared/inbound-attachment-writer.js';

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

class MemoryAttachmentRepository implements MessageAttachmentRepository {
  readonly attachments = new Map<string, ResolvableMessageAttachment>();
  storageUpdates = 0;
  readonly storageClaims: Array<{
    expectedStorageRef?: string;
    storageRef: string;
  }> = [];
  tombstoneUpdates = 0;
  tombstoneBeforeStorageClaim = false;
  storageClaimError: Error | undefined;
  storageRefBeforeTombstone: string | undefined;
  lookupOverride:
    | ((attachmentId: string) => Promise<ResolvableMessageAttachment | null>)
    | undefined;

  async getResolvableAttachment(attachmentId: string) {
    if (this.lookupOverride) return this.lookupOverride(attachmentId);
    return this.attachments.get(attachmentId) ?? null;
  }

  async setStorageRefIfAbsent(input: {
    attachmentId: string;
    expectedMessageId: string;
    expectedAppId: string;
    expectedConversationId: ResolvableMessageAttachment['conversationId'];
    expectedProviderAccountId: string;
    expectedProviderFetch?: NonNullable<
      ResolvableMessageAttachment['providerFetch']
    >;
    expectedStorageRef?: string;
    storageRef: string;
    fileName?: string;
    contentType?: string;
    sizeBytes?: number;
  }) {
    if (this.storageClaimError) throw this.storageClaimError;
    this.storageClaims.push({
      ...(input.expectedStorageRef !== undefined
        ? { expectedStorageRef: input.expectedStorageRef }
        : {}),
      storageRef: input.storageRef,
    });
    const attachment = this.attachments.get(input.attachmentId);
    if (!attachment) return { status: 'missing' as const };
    if (
      attachment.messageId !== input.expectedMessageId ||
      attachment.appId !== input.expectedAppId ||
      attachment.conversationId !== input.expectedConversationId ||
      attachment.providerAccountId !== input.expectedProviderAccountId
    ) {
      return { status: 'missing' as const };
    }
    if (
      input.expectedProviderFetch &&
      !sameProviderFetch(attachment.providerFetch, input.expectedProviderFetch)
    ) {
      return { status: 'stale' as const };
    }
    if (this.tombstoneBeforeStorageClaim) {
      attachment.deletedAt = '2026-07-31T00:00:00.000Z';
      this.tombstoneUpdates += 1;
    }
    if (attachment.deletedAt) return { status: 'deleted' as const };
    if (
      !attachment.storageRef ||
      attachment.storageRef === input.expectedStorageRef
    ) {
      attachment.storageRef = input.storageRef;
      attachment.fileName = input.fileName;
      attachment.contentType = input.contentType;
      attachment.sizeBytes = input.sizeBytes;
      this.storageUpdates += 1;
    }
    return attachment.storageRef
      ? {
          status: 'materialized' as const,
          attachment: {
            storageRef: attachment.storageRef,
            ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
            ...(attachment.contentType
              ? { contentType: attachment.contentType }
              : {}),
            ...(attachment.sizeBytes !== undefined
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
          },
        }
      : { status: 'missing' as const };
  }

  async setDeletedAt(input: {
    attachmentId: string;
    expectedMessageId: string;
    expectedAppId: string;
    expectedConversationId: ResolvableMessageAttachment['conversationId'];
    expectedProviderAccountId: string;
    expectedProviderFetch?: NonNullable<
      ResolvableMessageAttachment['providerFetch']
    >;
    deletedAt: string;
  }) {
    const attachment = this.attachments.get(input.attachmentId);
    if (!attachment) return { tombstoned: false };
    if (
      attachment.messageId !== input.expectedMessageId ||
      attachment.appId !== input.expectedAppId ||
      attachment.conversationId !== input.expectedConversationId ||
      attachment.providerAccountId !== input.expectedProviderAccountId
    ) {
      return { tombstoned: false };
    }
    if (
      input.expectedProviderFetch &&
      !sameProviderFetch(attachment.providerFetch, input.expectedProviderFetch)
    ) {
      return { tombstoned: false, stale: true };
    }
    if (this.storageRefBeforeTombstone) {
      attachment.storageRef = this.storageRefBeforeTombstone;
    }
    if (attachment.deletedAt) {
      return {
        tombstoned: true,
        ...(attachment.storageRef ? { storageRef: attachment.storageRef } : {}),
      };
    }
    attachment.deletedAt = input.deletedAt;
    this.tombstoneUpdates += 1;
    return {
      tombstoned: true,
      ...(attachment.storageRef ? { storageRef: attachment.storageRef } : {}),
    };
  }
}

function sameProviderFetch(
  left: ResolvableMessageAttachment['providerFetch'],
  right: NonNullable<ResolvableMessageAttachment['providerFetch']>,
): boolean {
  return (
    left?.provider === right.provider &&
    left.kind === right.kind &&
    left.id === right.id
  );
}

function attachment(
  overrides: Partial<ResolvableMessageAttachment> = {},
): ResolvableMessageAttachment {
  return {
    id: 'attachment-1',
    messageId: 'message-1',
    appId: 'app-1',
    conversationId: 'conversation-1' as never,
    conversationJid: 'sl:C1',
    providerAccountId: 'provider-account-1',
    fileName: 'report.txt',
    contentType: 'text/plain',
    providerFetch: {
      provider: 'slack',
      kind: 'file_id',
      id: 'F1',
    },
    ...overrides,
  };
}

function openRequest(
  overrides: Partial<Parameters<AttachmentResolver['open']>[0]> = {},
): Parameters<AttachmentResolver['open']>[0] {
  return {
    attachmentId: 'attachment-1',
    appId: 'app-1',
    providerAccountId: 'provider-account-1',
    conversationJid: 'sl:C1',
    ...overrides,
  };
}

function fetcher(
  implementation: (
    input: Parameters<
      HistoricalAttachmentFetcher['fetchHistoricalAttachment']
    >[0],
  ) =>
    | HistoricalAttachmentFetchResult
    | Promise<HistoricalAttachmentFetchResult>,
): HistoricalAttachmentFetcher & { calls: number } {
  return {
    calls: 0,
    async fetchHistoricalAttachment(input) {
      this.calls += 1;
      return implementation(input);
    },
  };
}

function createResolver(input: {
  repository: MemoryAttachmentRepository;
  fetcher: HistoricalAttachmentFetcher;
  materializationRoot?: string;
  workspaceRoots?: string[];
  writeAttachment?: typeof writeInboundAttachment;
  createStorageRef?: (fileName: string) => string;
  openTimeoutMs?: number;
}) {
  return new AttachmentResolver({
    repository: input.repository,
    fetcher: input.fetcher,
    materializationRoot:
      input.materializationRoot ?? tempRoot('gantry-provider-attachments'),
    workspaceRoots: () =>
      input.workspaceRoots ?? [tempRoot('gantry-workspace')],
    writeAttachment: input.writeAttachment,
    createStorageRef:
      input.createStorageRef ?? (() => 'provider-attachments/report.txt'),
    now: () => '2026-07-31T00:00:00.000Z',
    openTimeoutMs: input.openTimeoutMs,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('AttachmentResolver', () => {
  it('hides foreign canonical conversation scopes as not found and allows any thread in the owning conversation', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const provider = fetcher(() => ({
      status: 'ok',
      content: Buffer.from('conversation content'),
      fileName: 'report.txt',
      contentType: 'text/plain',
    }));
    const resolver = createResolver({ repository, fetcher: provider });

    await expect(
      resolver.open(
        openRequest({
          conversationJid: 'sl:FOREIGN',
        }),
      ),
    ).resolves.toEqual({
      status: 'not_found',
      content: ATTACHMENT_NOT_FOUND_COPY,
    });
    await expect(
      resolver.open(openRequest({ appId: 'app-foreign' })),
    ).resolves.toEqual({
      status: 'not_found',
      content: ATTACHMENT_NOT_FOUND_COPY,
    });
    await expect(
      resolver.open(
        openRequest({ providerAccountId: 'provider-account-foreign' }),
      ),
    ).resolves.toEqual({
      status: 'not_found',
      content: ATTACHMENT_NOT_FOUND_COPY,
    });
    const opened = await resolver.open(
      openRequest({ threadId: 'thread:any-in-conversation' }),
    );

    expect(opened).toMatchObject({
      status: 'opened',
      content: 'conversation content',
    });
    expect(provider.calls).toBe(1);
  });

  it('fetches through the hardened writer once, persists atomically, and materializes outside every workspace root', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const provider = fetcher(() => ({
      status: 'ok',
      content: Buffer.from('writer proof'),
      fileName: 'report.txt',
      contentType: 'text/plain',
    }));
    const writerSpy = vi.fn(writeInboundAttachment);
    const materializationRoot = tempRoot('gantry-provider-attachments');
    const workspaceRoots = [
      tempRoot('gantry-workspace-a'),
      tempRoot('gantry-workspace-b'),
    ];
    const resolver = createResolver({
      repository,
      fetcher: provider,
      materializationRoot,
      workspaceRoots,
      writeAttachment: writerSpy,
    });

    const first = await resolver.open(openRequest());
    const second = await resolver.open(openRequest());

    expect(first).toMatchObject({ status: 'opened', content: 'writer proof' });
    expect(second).toMatchObject({ status: 'opened', content: 'writer proof' });
    expect(provider.calls).toBe(1);
    expect(writerSpy).toHaveBeenCalledTimes(1);
    expect(writerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: fs.realpathSync(materializationRoot),
        workspaceRelativePath: 'report.txt',
        maxBytes: ATTACHMENT_MAX_BYTES,
      }),
    );
    expect(repository.storageUpdates).toBe(1);
    const materializedPath =
      first.status === 'opened' ? first.materializedPath : '';
    for (const workspaceRoot of workspaceRoots) {
      expect(path.relative(workspaceRoot, materializedPath)).toMatch(/^\.\./);
    }
  });

  it('persists fetched filename and content type with the winning storage reference', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set(
      'attachment-1',
      attachment({ fileName: undefined, contentType: undefined }),
    );
    const provider = fetcher(() => ({
      status: 'ok',
      content: Buffer.from('metadata survives'),
      fileName: 'notes.txt',
      contentType: 'text/plain',
    }));
    const materializationRoot = tempRoot('gantry-provider-attachments');
    const firstResolver = createResolver({
      repository,
      fetcher: provider,
      materializationRoot,
    });

    await expect(firstResolver.open(openRequest())).resolves.toMatchObject({
      status: 'opened',
      content: 'metadata survives',
    });
    expect(repository.attachments.get('attachment-1')).toMatchObject({
      fileName: 'notes.txt',
      contentType: 'text/plain',
      sizeBytes: Buffer.byteLength('metadata survives'),
    });

    const secondProvider = fetcher(() => {
      throw new Error('materialized opens must not refetch');
    });
    const secondResolver = createResolver({
      repository,
      fetcher: secondProvider,
      materializationRoot,
    });
    await expect(secondResolver.open(openRequest())).resolves.toMatchObject({
      status: 'opened',
      content: 'metadata survives',
    });
    expect(secondProvider.calls).toBe(0);
  });

  it('re-materializes a legacy live ref when provider fetch identity is available', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set(
      'attachment-1',
      attachment({ storageRef: 'attachments/legacy-report.txt' }),
    );
    const provider = fetcher(() => ({
      status: 'ok',
      content: Buffer.from('re-materialized content'),
      fileName: 'report.txt',
      contentType: 'text/plain',
    }));
    const resolver = createResolver({ repository, fetcher: provider });

    await expect(resolver.open(openRequest())).resolves.toMatchObject({
      status: 'opened',
      content: 're-materialized content',
      storageRef: 'provider-attachments/report.txt',
    });
    expect(provider.calls).toBe(1);
    expect(repository.attachments.get('attachment-1')?.storageRef).toBe(
      'provider-attachments/report.txt',
    );
  });

  it('re-fetches and CASes a fresh ref when an existing provider file is unreadable', async () => {
    const repository = new MemoryAttachmentRepository();
    const oldStorageRef = 'provider-attachments/unreadable-old.txt';
    repository.attachments.set(
      'attachment-1',
      attachment({ storageRef: oldStorageRef }),
    );
    const provider = fetcher(() => ({
      status: 'ok',
      content: Buffer.from('self-healed content'),
      fileName: 'report.txt',
      contentType: 'text/plain',
    }));
    const materializationRoot = tempRoot('gantry-provider-attachments');
    const unreadablePath = path.join(materializationRoot, 'unreadable-old.txt');
    fs.writeFileSync(unreadablePath, 'existing unreadable bytes');
    fs.chmodSync(unreadablePath, 0o000);
    const resolver = createResolver({
      repository,
      fetcher: provider,
      materializationRoot,
      createStorageRef: () => 'provider-attachments/fresh.txt',
    });

    try {
      await expect(resolver.open(openRequest())).resolves.toMatchObject({
        status: 'opened',
        content: 'self-healed content',
        storageRef: 'provider-attachments/fresh.txt',
      });
      expect(provider.calls).toBe(1);
      expect(repository.storageClaims).toEqual([
        {
          expectedStorageRef: oldStorageRef,
          storageRef: 'provider-attachments/fresh.txt',
        },
      ]);
      expect(repository.attachments.get('attachment-1')?.storageRef).toBe(
        'provider-attachments/fresh.txt',
      );
      expect(
        fs.readFileSync(path.join(materializationRoot, 'fresh.txt'), 'utf8'),
      ).toBe('self-healed content');
      expect(fs.existsSync(unreadablePath)).toBe(true);
    } finally {
      fs.chmodSync(unreadablePath, 0o600);
    }
  });

  it('returns honest unreachable copy for a missing provider ref without fetch identity', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set(
      'attachment-1',
      attachment({
        storageRef: 'provider-attachments/reclaimed-report.txt',
        providerFetch: undefined,
      }),
    );
    const provider = fetcher(() => {
      throw new Error('provider must not run without fetch identity');
    });
    const resolver = createResolver({ repository, fetcher: provider });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
    expect(provider.calls).toBe(0);
    expect(repository.storageClaims).toEqual([]);
  });

  it('returns honest unreachable copy for a legacy live ref without provider fetch identity', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set(
      'attachment-1',
      attachment({
        storageRef: 'attachments/legacy-report.txt',
        providerFetch: undefined,
      }),
    );
    const provider = fetcher(() => {
      throw new Error('provider must not run without fetch identity');
    });
    const resolver = createResolver({ repository, fetcher: provider });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
    expect(provider.calls).toBe(0);
  });

  it('rejects a materialization root that resolves through a symlink into a workspace', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const provider = fetcher(() => ({
      status: 'ok',
      content: Buffer.from('must stay outside'),
      contentType: 'text/plain',
    }));
    const workspaceRoot = tempRoot('gantry-workspace');
    const workspaceMaterialization = path.join(workspaceRoot, 'materialized');
    fs.mkdirSync(workspaceMaterialization);
    const outsideRoot = tempRoot('gantry-outside');
    const linkedRoot = path.join(outsideRoot, 'provider-attachments');
    fs.symlinkSync(workspaceMaterialization, linkedRoot, 'dir');
    const resolver = createResolver({
      repository,
      fetcher: provider,
      materializationRoot: linkedRoot,
      workspaceRoots: [workspaceRoot],
    });

    await expect(resolver.open(openRequest())).rejects.toThrow(
      'Provider attachment materialization root must be outside every workspace root.',
    );
    expect(repository.storageUpdates).toBe(0);
  });

  it('single-flights concurrent opens by durable attachment id', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = fetcher(async () => {
      await gate;
      return {
        status: 'ok',
        content: Buffer.from('single flight'),
        contentType: 'text/plain',
      };
    });
    const resolver = createResolver({ repository, fetcher: provider });

    const first = resolver.open(openRequest());
    const second = resolver.open(openRequest());
    await vi.waitFor(() => expect(provider.calls).toBe(1));
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'opened', content: 'single flight' }),
      expect.objectContaining({ status: 'opened', content: 'single flight' }),
    ]);
    expect(provider.calls).toBe(1);
    expect(repository.storageUpdates).toBe(1);
  });

  it('does not share or claim a result after the attachment id moves to another owner', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const releases: Array<() => void> = [];
    let call = 0;
    const provider = fetcher(
      () =>
        new Promise<HistoricalAttachmentFetchResult>((resolve) => {
          call += 1;
          const currentCall = call;
          releases.push(() =>
            resolve({
              status: 'ok',
              content: Buffer.from(`owner ${currentCall}`),
              contentType: 'text/plain',
            }),
          );
        }),
    );
    const resolver = createResolver({ repository, fetcher: provider });

    const oldOwner = resolver.open(openRequest());
    await vi.waitFor(() => expect(provider.calls).toBe(1));
    repository.attachments.set(
      'attachment-1',
      attachment({
        messageId: 'message-2',
        conversationId: 'conversation-2' as never,
        conversationJid: 'sl:C2',
      }),
    );
    const newOwner = resolver.open(openRequest({ conversationJid: 'sl:C2' }));
    await vi.waitFor(() => expect(provider.calls).toBe(2));

    releases[0]?.();
    await expect(oldOwner).resolves.toEqual({
      status: 'not_found',
      content: ATTACHMENT_NOT_FOUND_COPY,
    });
    releases[1]?.();
    await expect(newOwner).resolves.toMatchObject({
      status: 'opened',
      content: 'owner 2',
    });
    expect(repository.storageUpdates).toBe(1);
  });

  it('does not share or claim F1 bytes after the same attachment owner is replaced with F2', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const releases = new Map<string, () => void>();
    const provider = fetcher(
      (input) =>
        new Promise<HistoricalAttachmentFetchResult>((resolve) => {
          releases.set(input.identity.id, () =>
            resolve({
              status: 'ok',
              content: Buffer.from(`content ${input.identity.id}`),
              contentType: 'text/plain',
            }),
          );
        }),
    );
    let storageRefSequence = 0;
    const resolver = createResolver({
      repository,
      fetcher: provider,
      createStorageRef: () =>
        `provider-attachments/report-${++storageRefSequence}.txt`,
    });

    const f1Open = resolver.open(openRequest());
    await vi.waitFor(() => expect(provider.calls).toBe(1));
    repository.attachments.set(
      'attachment-1',
      attachment({
        providerFetch: {
          provider: 'slack',
          kind: 'file_id',
          id: 'F2',
        },
      }),
    );
    const f2Open = resolver.open(openRequest());
    await vi.waitFor(() => expect(provider.calls).toBe(2));

    releases.get('F1')?.();
    await vi.waitFor(() => expect(releases.has('F2')).toBe(true));
    releases.get('F2')?.();

    await expect(Promise.all([f1Open, f2Open])).resolves.toEqual([
      expect.objectContaining({ status: 'opened', content: 'content F2' }),
      expect.objectContaining({ status: 'opened', content: 'content F2' }),
    ]);
    expect(repository.attachments.get('attachment-1')).toMatchObject({
      providerFetch: { provider: 'slack', kind: 'file_id', id: 'F2' },
      storageRef: 'provider-attachments/report-2.txt',
    });
    expect(repository.storageUpdates).toBe(1);
  });

  it('does not apply an F1 deletion tombstone after the same attachment owner is replaced with F2', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    let releaseF1!: () => void;
    const f1Gate = new Promise<void>((resolve) => {
      releaseF1 = resolve;
    });
    const provider = fetcher(async (input) => {
      if (input.identity.id === 'F1') {
        await f1Gate;
        return { status: 'deleted' };
      }
      return { status: 'unreachable', reason: 'network' };
    });
    const resolver = createResolver({ repository, fetcher: provider });

    const pending = resolver.open(openRequest());
    await vi.waitFor(() => expect(provider.calls).toBe(1));
    repository.attachments.set(
      'attachment-1',
      attachment({
        providerFetch: {
          provider: 'slack',
          kind: 'file_id',
          id: 'F2',
        },
      }),
    );
    releaseF1();

    await expect(pending).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
    expect(provider.calls).toBe(2);
    expect(repository.attachments.get('attachment-1')).toMatchObject({
      providerFetch: { provider: 'slack', kind: 'file_id', id: 'F2' },
    });
    expect(
      repository.attachments.get('attachment-1')?.deletedAt,
    ).toBeUndefined();
    expect(repository.tombstoneUpdates).toBe(0);
  });

  it('ends a stalled provider call before the runner timeout and clears single-flight state for retry', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    let attempts = 0;
    let firstSignal: AbortSignal | undefined;
    const provider = fetcher(async (input) => {
      attempts += 1;
      if (attempts === 1) {
        firstSignal = input.signal;
        return new Promise<HistoricalAttachmentFetchResult>(() => undefined);
      }
      return { status: 'unreachable', reason: 'network' };
    });
    const resolver = createResolver({
      repository,
      fetcher: provider,
      openTimeoutMs: 5,
    });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
    expect(firstSignal?.aborted).toBe(true);
    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
    expect(provider.calls).toBe(2);
  });

  it('bounds a stalled repository lookup within the end-to-end open deadline', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.lookupOverride = async () =>
      new Promise<ResolvableMessageAttachment | null>(() => undefined);
    const provider = fetcher(() => {
      throw new Error('provider must not run before attachment ownership');
    });
    const resolver = createResolver({
      repository,
      fetcher: provider,
      openTimeoutMs: 5,
    });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
    expect(provider.calls).toBe(0);
  });

  it('refuses an over-cap stream through the 50 MiB writer limit and persists nothing', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    let readCount = 0;
    const provider = fetcher(() => ({
      status: 'ok',
      content: {
        async read() {
          readCount += 1;
          if (readCount === 1) {
            return { done: false, value: new Uint8Array(ATTACHMENT_MAX_BYTES) };
          }
          if (readCount === 2) {
            return { done: false, value: new Uint8Array(1) };
          }
          return { done: true };
        },
      },
    }));
    const writerSpy = vi.fn(writeInboundAttachment);
    const resolver = createResolver({
      repository,
      fetcher: provider,
      writeAttachment: writerSpy,
    });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'too_large',
      content: ATTACHMENT_TOO_LARGE_COPY,
    });
    expect(writerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: ATTACHMENT_MAX_BYTES }),
    );
    expect(repository.storageUpdates).toBe(0);
    expect(repository.attachments.get('attachment-1')?.storageRef).toBe(
      undefined,
    );
  });

  it('refuses an existing tombstone without a provider call', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set(
      'attachment-1',
      attachment({ deletedAt: '2026-07-30T00:00:00.000Z' }),
    );
    const provider = fetcher(() => ({
      status: 'ok',
      content: Buffer.from('must not fetch'),
    }));
    const resolver = createResolver({ repository, fetcher: provider });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'deleted',
      content: ATTACHMENT_DELETED_COPY,
    });
    expect(provider.calls).toBe(0);
  });

  it('loses materialization to a concurrent tombstone and removes the unwon file', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    repository.tombstoneBeforeStorageClaim = true;
    const provider = fetcher(() => ({
      status: 'ok',
      content: Buffer.from('must be removed'),
      contentType: 'text/plain',
    }));
    const materializationRoot = tempRoot('gantry-provider-attachments');
    const resolver = createResolver({
      repository,
      fetcher: provider,
      materializationRoot,
    });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'deleted',
      content: ATTACHMENT_DELETED_COPY,
    });
    expect(repository.storageUpdates).toBe(0);
    expect(fs.readdirSync(materializationRoot)).toEqual([]);
  });

  it('removes materialized bytes when the durable storage claim throws', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    repository.storageClaimError = new Error('database unavailable');
    const provider = fetcher(() => ({
      status: 'ok',
      content: Buffer.from('must not become orphaned'),
      contentType: 'text/plain',
    }));
    const materializationRoot = tempRoot('gantry-provider-attachments');
    const resolver = createResolver({
      repository,
      fetcher: provider,
      materializationRoot,
    });

    await expect(resolver.open(openRequest())).rejects.toThrow(
      'database unavailable',
    );
    expect(fs.readdirSync(materializationRoot)).toEqual([]);
  });

  it('persists only an explicit provider deletion and refuses it without fetching thereafter', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const provider = fetcher(() => ({ status: 'deleted' }));
    const resolver = createResolver({ repository, fetcher: provider });

    const first = await resolver.open(openRequest());
    const second = await resolver.open(openRequest());

    expect(first).toEqual({
      status: 'deleted',
      content: ATTACHMENT_DELETED_COPY,
    });
    expect(second).toEqual(first);
    expect(provider.calls).toBe(1);
    expect(repository.tombstoneUpdates).toBe(1);
  });

  it('leaves a shared tombstoned ref to reference-aware repository cleanup', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    repository.storageRefBeforeTombstone =
      'provider-attachments/other-worker.txt';
    repository.attachments.set(
      'attachment-2',
      attachment({
        id: 'attachment-2',
        storageRef: 'provider-attachments/other-worker.txt',
      }),
    );
    const provider = fetcher(() => ({ status: 'deleted' }));
    const materializationRoot = tempRoot('gantry-provider-attachments');
    const claimedPath = path.join(materializationRoot, 'other-worker.txt');
    fs.writeFileSync(claimedPath, 'already materialized');
    const resolver = createResolver({
      repository,
      fetcher: provider,
      materializationRoot,
    });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'deleted',
      content: ATTACHMENT_DELETED_COPY,
    });
    expect(fs.readFileSync(claimedPath, 'utf8')).toBe('already materialized');
    expect(repository.tombstoneUpdates).toBe(1);
  });

  it.each(['not_found', 'auth', 'rate_limit'] as const)(
    'keeps %s unreachable and retryable without tombstoning',
    async (reason) => {
      const repository = new MemoryAttachmentRepository();
      repository.attachments.set('attachment-1', attachment());
      const provider = fetcher(() => ({ status: 'unreachable', reason }));
      const resolver = createResolver({ repository, fetcher: provider });

      await expect(resolver.open(openRequest())).resolves.toEqual({
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      });
      expect(repository.tombstoneUpdates).toBe(0);
      expect(repository.attachments.get('attachment-1')?.deletedAt).toBe(
        undefined,
      );
    },
  );
});
