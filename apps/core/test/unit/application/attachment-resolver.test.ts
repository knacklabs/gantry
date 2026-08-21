import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ATTACHMENT_DELETED_COPY,
  ATTACHMENT_NOT_FOUND_COPY,
  ATTACHMENT_RATE_LIMITED_COPY,
  ATTACHMENT_TIMEOUT_COPY,
  ATTACHMENT_TOO_LARGE_COPY,
  ATTACHMENT_TRANSPORT_COPY,
  ATTACHMENT_UNREACHABLE_COPY,
  attachmentPermissionScopeCopy,
} from '@core/application/attachments/attachment-failure.js';
import {
  ATTACHMENT_MAX_BYTES,
  AttachmentResolver,
} from '@core/application/attachments/attachment-resolver.js';
import { fetchSlackHistoricalAttachment } from '@core/channels/slack/historical-attachment-fetcher.js';
import type {
  HistoricalAttachmentFetchResult,
  HistoricalAttachmentFetcher,
} from '@core/domain/ports/historical-attachment-fetcher.js';
import type {
  MessageAttachmentRepository,
  ResolvableMessageAttachment,
} from '@core/domain/ports/message-attachment-repository.js';
import { logger } from '@core/infrastructure/logging/logger.js';
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
  cleanupProviderAttachment: (storageRef: string) => Promise<void> = async () =>
    undefined;
  reclamationAttempts = 0;
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

  async setDeletedAtByMessageExternalIds() {
    return { tombstonedAttachments: [] };
  }

  async retryPendingMessageAttachmentDeletions() {
    return false;
  }

  async reclaimTombstonedStorageRef(input: {
    attachmentId: string;
    messageId: string;
    storageRef: string;
  }): Promise<void> {
    this.reclamationAttempts += 1;
    const attachment = this.attachments.get(input.attachmentId);
    if (
      !attachment?.deletedAt ||
      attachment.messageId !== input.messageId ||
      attachment.storageRef !== input.storageRef
    ) {
      return;
    }
    const shared = [...this.attachments.values()].some(
      (candidate) =>
        candidate.id !== input.attachmentId &&
        candidate.storageRef === input.storageRef,
    );
    if (!shared) await this.cleanupProviderAttachment(input.storageRef);
    delete attachment.storageRef;
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
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it('returns workspace-local refs directly in materialize mode when the file exists', async () => {
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const workspaceRoot = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'ws-'));
    await fsp.mkdir(pathMod.join(workspaceRoot, 'attachments'));
    await fsp.writeFile(
      pathMod.join(workspaceRoot, 'attachments', 'live-report.csv'),
      'a,b',
    );
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set(
      'attachment-1',
      attachment({
        storageRef: 'attachments/live-report.csv',
        providerFetch: undefined,
      }),
    );
    const provider = fetcher(() => {
      throw new Error('workspace-local materialize must not fetch');
    });
    const resolver = createResolver({ repository, fetcher: provider });

    await expect(
      resolver.open(openRequest({ mode: 'materialize', workspaceRoot })),
    ).resolves.toEqual({
      status: 'already_in_workspace',
      content: 'Attachment is already in the workspace.',
      workspaceRelativePath: 'attachments/live-report.csv',
      fileName: 'report.txt',
    });
    expect(provider.calls).toBe(0);
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('falls through to provider recovery when the workspace-local file is stale', async () => {
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const workspaceRoot = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'ws-'));
    // No attachments/live-report.csv on disk: the syntax-only short-circuit
    // must not fire; the resolver continues into provider-fetch recovery.
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set(
      'attachment-1',
      attachment({ storageRef: 'attachments/live-report.csv' }),
    );
    const provider = fetcher(() => ({
      status: 'ok' as const,
      content: new TextEncoder().encode('recovered'),
      fileName: 'live-report.csv',
    }));
    const resolver = createResolver({ repository, fetcher: provider });

    const result = await resolver.open(
      openRequest({ mode: 'materialize', workspaceRoot }),
    );
    expect(result.status).not.toBe('already_in_workspace');
    expect(provider.calls).toBeGreaterThan(0);
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('skips attachment view extraction in materialize mode and returns the canonical file name', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set(
      'attachment-1',
      attachment({
        storageRef: 'provider-attachments/report.pdf',
        fileName: 'report.pdf',
        contentType: 'application/pdf',
      }),
    );
    const provider = fetcher(() => {
      throw new Error('materialized attachments must not refetch');
    });
    const materializationRoot = tempRoot('gantry-provider-attachments');
    const materializedPath = path.join(materializationRoot, 'report.pdf');
    fs.writeFileSync(materializedPath, Buffer.from('%PDF-not-extracted'));
    const resolver = createResolver({
      repository,
      fetcher: provider,
      materializationRoot,
    });

    await expect(
      resolver.open(openRequest({ mode: 'materialize' })),
    ).resolves.toEqual({
      status: 'opened',
      content: '',
      materializedPath: fs.realpathSync(materializedPath),
      storageRef: 'provider-attachments/report.pdf',
      fileName: 'report.pdf',
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

  it('keeps a joined waiter on its own deadline after the first caller times out', async () => {
    vi.useFakeTimers();
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    let release!: () => void;
    const provider = fetcher(
      () =>
        new Promise<HistoricalAttachmentFetchResult>((resolve) => {
          release = () => resolve({ status: 'unreachable', reason: 'network' });
        }),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const resolver = createResolver({
      repository,
      fetcher: provider,
      openTimeoutMs: 5,
    });

    const first = resolver.open(openRequest());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2);
    const second = resolver.open(openRequest());
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(3);
    await expect(first).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_TIMEOUT_COPY,
    });
    release();
    await vi.advanceTimersByTimeAsync(0);

    await expect(second).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_TRANSPORT_COPY,
    });
    expect(warn.mock.calls.map(([context]) => context.cause)).toEqual([
      'timeout',
      'transport',
    ]);
  });

  it('logs one timeout when the owner and a joined waiter both expire across a stale retry', async () => {
    vi.useFakeTimers();
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const gates = new Map<string, () => void>();
    const provider = fetcher(
      (input) =>
        new Promise<HistoricalAttachmentFetchResult>((resolve) => {
          // F1 reports deleted (drives the stale retry once the row is F2);
          // F2 never settles, so both callers reach the deadline.
          gates.set(input.identity.id, () => resolve({ status: 'deleted' }));
        }),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const resolver = createResolver({
      repository,
      fetcher: provider,
      openTimeoutMs: 50,
    });

    const owner = resolver.open(openRequest());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2);
    // Joins the still-in-flight F1 before its provider id changes.
    const joined = resolver.open(openRequest());
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(1);

    // Move the row to F2 so F1's persist is stale, then release F1: the owner
    // retries into F2 (never released), carrying the joined waiter with it.
    repository.attachments.set(
      'attachment-1',
      attachment({
        providerFetch: { provider: 'slack', kind: 'file_id', id: 'F2' },
      }),
    );
    gates.get('F1')?.();
    // Flush the persist->stale->retry microtasks without consuming the deadline.
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(2);

    await vi.advanceTimersByTimeAsync(60);
    await expect(owner).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_TIMEOUT_COPY,
    });
    await expect(joined).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_TIMEOUT_COPY,
    });
    expect(
      warn.mock.calls.filter(([context]) => context.cause === 'timeout').length,
    ).toBe(1);
  });

  it('logs one timeout when a stale retry joins an F2 flight already in progress', async () => {
    vi.useFakeTimers();
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const gates = new Map<string, () => void>();
    const provider = fetcher(
      (input) =>
        new Promise<HistoricalAttachmentFetchResult>((resolve) => {
          // F1 reports deleted to drive the stale retry; F2 never settles so
          // both the F2 owner and the retry that joins it reach the deadline.
          gates.set(input.identity.id, () => resolve({ status: 'deleted' }));
        }),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const resolver = createResolver({
      repository,
      fetcher: provider,
      openTimeoutMs: 100,
    });

    // A owns F1 (row still F1).
    const staleChain = resolver.open(openRequest());
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(1);

    // Row moves to F2; C opens and creates+owns the F2 flight.
    repository.attachments.set(
      'attachment-1',
      attachment({
        providerFetch: { provider: 'slack', kind: 'file_id', id: 'F2' },
      }),
    );
    await vi.advanceTimersByTimeAsync(2);
    const f2Owner = resolver.open(openRequest());
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(2);

    // Release F1: A's stale retry recomputes the key to F2 and JOINS C's flight
    // rather than creating a new one, so A is a non-owner of F2.
    gates.get('F1')?.();
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(2);

    await vi.advanceTimersByTimeAsync(120);
    await expect(staleChain).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_TIMEOUT_COPY,
    });
    await expect(f2Owner).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_TIMEOUT_COPY,
    });
    expect(
      warn.mock.calls.filter(([context]) => context.cause === 'timeout').length,
    ).toBe(1);
  });

  it('still logs the timeout when the earlier joiner expires before the F2 owner settles', async () => {
    // The lost-diagnostic case: an older F1 chain joins a younger F2 owner, the
    // older caller's deadline fires first, then F2 settles (no timeout) before
    // the owner's later deadline. Exactly one timeout warning must survive.
    vi.useFakeTimers();
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const gates = new Map<string, () => void>();
    const provider = fetcher(
      (input) =>
        new Promise<HistoricalAttachmentFetchResult>((resolve) => {
          gates.set(input.identity.id, () =>
            resolve(
              input.identity.id === 'F1'
                ? { status: 'deleted' }
                : { status: 'unreachable', reason: 'network' },
            ),
          );
        }),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const resolver = createResolver({
      repository,
      fetcher: provider,
      openTimeoutMs: 100,
    });

    const staleChain = resolver.open(openRequest());
    await vi.advanceTimersByTimeAsync(0);
    repository.attachments.set(
      'attachment-1',
      attachment({
        providerFetch: { provider: 'slack', kind: 'file_id', id: 'F2' },
      }),
    );
    await vi.advanceTimersByTimeAsync(2);
    const f2Owner = resolver.open(openRequest());
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(2);

    gates.get('F1')?.();
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(2);

    // Fire the older caller's deadline (t=100) but not the F2 owner's (t=102).
    await vi.advanceTimersByTimeAsync(99);
    await expect(staleChain).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_TIMEOUT_COPY,
    });

    // F2 settles as transport before its owner ever times out.
    gates.get('F2')?.();
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
    await expect(f2Owner).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_TRANSPORT_COPY,
    });
    expect(
      warn.mock.calls.filter(([context]) => context.cause === 'timeout').length,
    ).toBe(1);
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
      content: ATTACHMENT_TRANSPORT_COPY,
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
      content: ATTACHMENT_TIMEOUT_COPY,
    });
    expect(firstSignal?.aborted).toBe(true);
    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_TRANSPORT_COPY,
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
      content: ATTACHMENT_TIMEOUT_COPY,
    });
    expect(provider.calls).toBe(0);
  });

  it.each(['unreachable', 'deleted', 'too_large'] as const)(
    'keeps timeout as the only terminal log when %s settles after the deadline',
    async (lateFailure) => {
      const repository = new MemoryAttachmentRepository();
      repository.attachments.set('attachment-1', attachment());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let lateSettlementFinished!: () => void;
      const lateSettlement = new Promise<void>((resolve) => {
        lateSettlementFinished = resolve;
      });
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const provider = fetcher(async () => {
        if (lateFailure === 'too_large') {
          return { status: 'ok', content: Buffer.from('late bytes') };
        }
        await gate;
        lateSettlementFinished();
        return lateFailure === 'deleted'
          ? { status: 'deleted' }
          : { status: 'unreachable', reason: 'network' };
      });
      const resolver = createResolver({
        repository,
        fetcher: provider,
        openTimeoutMs: 5,
        ...(lateFailure === 'too_large'
          ? {
              writeAttachment: async () => {
                await gate;
                lateSettlementFinished();
                return { status: 'too-large', bytes: ATTACHMENT_MAX_BYTES + 1 };
              },
            }
          : {}),
      });

      await expect(resolver.open(openRequest())).resolves.toEqual({
        status: 'unreachable',
        content: ATTACHMENT_TIMEOUT_COPY,
      });
      release();
      await lateSettlement;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        {
          cause: 'timeout',
          provider: 'unknown',
          providerAccountId: 'provider-account-1',
          conversationJid: 'sl:C1',
          attachmentId: 'attachment-1',
          elapsedMs: expect.any(Number),
        },
        'Attachment unavailable',
      );
      expect(repository.tombstoneUpdates).toBe(0);
      expect(
        repository.attachments.get('attachment-1')?.deletedAt,
      ).toBeUndefined();
    },
  );

  it('refuses an over-cap stream through the 50 MiB writer limit and persists nothing', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    let readCount = 0;
    const cancel = vi.fn(async () => undefined);
    let fetchSignal: AbortSignal | undefined;
    const provider = fetcher((input) => {
      fetchSignal = input.signal;
      return {
        status: 'ok',
        content: {
          async read() {
            readCount += 1;
            if (readCount === 1) {
              return {
                done: false,
                value: new Uint8Array(ATTACHMENT_MAX_BYTES),
              };
            }
            if (readCount === 2) {
              return { done: false, value: new Uint8Array(1) };
            }
            return { done: true };
          },
          cancel,
        },
      };
    });
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
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchSignal?.aborted).toBe(true);
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

  it('reclaims a crash-pending tombstone on the next open and still refuses it', async () => {
    const repository = new MemoryAttachmentRepository();
    const storageRef = 'provider-attachments/pending-delete.txt';
    repository.attachments.set(
      'attachment-1',
      attachment({
        deletedAt: '2026-07-30T00:00:00.000Z',
        storageRef,
      }),
    );
    const materializationRoot = tempRoot('gantry-provider-attachments');
    const materializedPath = path.join(
      materializationRoot,
      'pending-delete.txt',
    );
    fs.writeFileSync(materializedPath, 'must be reclaimed');
    repository.cleanupProviderAttachment = async (ref) => {
      expect(ref).toBe(storageRef);
      fs.rmSync(materializedPath);
    };
    const provider = fetcher(() => {
      throw new Error('tombstones must not refetch');
    });
    const resolver = createResolver({
      repository,
      fetcher: provider,
      materializationRoot,
    });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'deleted',
      content: ATTACHMENT_DELETED_COPY,
    });
    expect(fs.existsSync(materializedPath)).toBe(false);
    expect(
      repository.attachments.get('attachment-1')?.storageRef,
    ).toBeUndefined();
    expect(repository.reclamationAttempts).toBe(1);
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

  it('does not persist or tombstone a Slack HTML historical response', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const provider: HistoricalAttachmentFetcher = {
      fetchHistoricalAttachment: (input) =>
        fetchSlackHistoricalAttachment(
          { identity: input.identity },
          {
            filesInfo: async () => ({
              file: {
                name: 'report.txt',
                url_private_download: 'https://files.slack.test/F1',
              },
            }),
            download: async () =>
              new Response('file_deleted', {
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
              }),
          },
        ),
    };
    const resolver = createResolver({ repository, fetcher: provider });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
    expect(repository.storageUpdates).toBe(0);
    expect(repository.storageClaims).toEqual([]);
    expect(repository.tombstoneUpdates).toBe(0);
    expect(
      repository.attachments.get('attachment-1')?.storageRef,
    ).toBeUndefined();
    expect(
      repository.attachments.get('attachment-1')?.deletedAt,
    ).toBeUndefined();
  });

  it('returns rate-limit copy for a Slack HTML-shaped 429 response', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const provider: HistoricalAttachmentFetcher = {
      fetchHistoricalAttachment: (input) =>
        fetchSlackHistoricalAttachment(
          { identity: input.identity },
          {
            filesInfo: async () => ({
              file: {
                name: 'report.txt',
                url_private_download: 'https://files.slack.test/F1',
              },
            }),
            download: async () =>
              new Response('<html>rate limited</html>', {
                status: 429,
                headers: { 'content-type': 'text/html; charset=utf-8' },
              }),
          },
        ),
    };
    const resolver = createResolver({ repository, fetcher: provider });

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_RATE_LIMITED_COPY,
    });
  });

  it.each([401, 403])(
    'keeps Slack HTTP-error status %s on the legacy sentence instead of transport copy',
    async (statusCode) => {
      const repository = new MemoryAttachmentRepository();
      repository.attachments.set('attachment-1', attachment());
      const provider: HistoricalAttachmentFetcher = {
        fetchHistoricalAttachment: (input) =>
          fetchSlackHistoricalAttachment(
            { identity: input.identity },
            {
              filesInfo: async () => {
                throw Object.assign(new Error('authorization failed'), {
                  code: 'slack_webapi_http_error',
                  statusCode,
                });
              },
              download: vi.fn(),
            },
          ),
      };
      const resolver = createResolver({ repository, fetcher: provider });

      const result = await resolver.open(openRequest());

      expect(result).toEqual({
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      });
      expect(result.content).not.toBe(ATTACHMENT_TRANSPORT_COPY);
    },
  );

  it.each([
    [
      'incapable',
      { status: 'unreachable', reason: 'incapable' },
      ATTACHMENT_UNREACHABLE_COPY,
    ],
    [
      'not_found',
      { status: 'unreachable', reason: 'not_found' },
      ATTACHMENT_UNREACHABLE_COPY,
    ],
    [
      'auth',
      { status: 'unreachable', reason: 'auth' },
      ATTACHMENT_UNREACHABLE_COPY,
    ],
    [
      'missing_scope',
      {
        status: 'unreachable',
        reason: 'missing_scope',
        scope: 'files:read',
      },
      attachmentPermissionScopeCopy('files:read'),
    ],
    [
      'rate_limit',
      { status: 'unreachable', reason: 'rate_limit' },
      ATTACHMENT_RATE_LIMITED_COPY,
    ],
  ] as const)(
    'keeps %s unreachable and retryable without tombstoning',
    async (_reason, failure, content) => {
      const repository = new MemoryAttachmentRepository();
      repository.attachments.set('attachment-1', attachment());
      const provider = fetcher(() => failure);
      const resolver = createResolver({ repository, fetcher: provider });

      await expect(resolver.open(openRequest())).resolves.toEqual({
        status: 'unreachable',
        content,
      });
      expect(repository.tombstoneUpdates).toBe(0);
      expect(repository.attachments.get('attachment-1')?.deletedAt).toBe(
        undefined,
      );
    },
  );

  it('logs incapable routing exactly once with host attachment context', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const provider = fetcher(() => ({
      status: 'unreachable',
      reason: 'incapable',
    }));
    const resolver = createResolver({ repository, fetcher: provider });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_UNREACHABLE_COPY,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        cause: 'unknown',
        provider: 'slack',
        providerAccountId: 'provider-account-1',
        conversationJid: 'sl:C1',
        attachmentId: 'attachment-1',
        elapsedMs: expect.any(Number),
      },
      'Attachment unavailable',
    );
  });

  it('carries a Slack SDK 429 status into the emitted warning', async () => {
    const repository = new MemoryAttachmentRepository();
    repository.attachments.set('attachment-1', attachment());
    const provider: HistoricalAttachmentFetcher = {
      fetchHistoricalAttachment: (input) =>
        fetchSlackHistoricalAttachment(
          { identity: input.identity },
          {
            filesInfo: async () => {
              throw Object.assign(new Error('rate limited'), {
                code: 'slack_webapi_rate_limited_error',
                statusCode: 429,
              });
            },
            download: vi.fn(),
          },
        ),
    };
    const resolver = createResolver({ repository, fetcher: provider });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(resolver.open(openRequest())).resolves.toEqual({
      status: 'unreachable',
      content: ATTACHMENT_RATE_LIMITED_COPY,
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      {
        cause: 'rate_limited',
        provider: 'slack',
        providerAccountId: 'provider-account-1',
        conversationJid: 'sl:C1',
        attachmentId: 'attachment-1',
        providerStatus: 429,
        elapsedMs: expect.any(Number),
      },
      'Attachment unavailable',
    );
  });
});
