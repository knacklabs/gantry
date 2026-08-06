import type {
  HistoricalAttachmentFetcher,
  HistoricalAttachmentReader,
} from '../../domain/ports/historical-attachment-fetcher.js';
import type {
  MessageAttachmentRepository,
  ResolvableMessageAttachment,
} from '../../domain/ports/message-attachment-repository.js';
import {
  workspaceLocalRegularFile,
  createProviderAttachmentStorageRef,
  isProviderAttachmentStorageRef,
  materializeProviderAttachment,
  providerAttachmentWriter,
  readProviderAttachment,
  removeProviderAttachment,
  type AttachmentImagePayload,
  type ProviderAttachmentWriter,
} from '../../shared/provider-attachment-materialization.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  ATTACHMENT_DELETED_COPY,
  ATTACHMENT_NOT_FOUND_COPY,
  ATTACHMENT_UNREACHABLE_COPY,
  classifyAndLogAttachmentFailure,
  type AttachmentFailureEvidence,
} from './attachment-failure.js';

export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const ATTACHMENT_OPEN_TIMEOUT_MS = 110_000;

export type AttachmentOpenResult =
  | {
      status: 'opened';
      content: string;
      image?: AttachmentImagePayload;
      materializedPath: string;
      storageRef: string;
      fileName: string;
    }
  | {
      status: 'already_in_workspace';
      content: string;
      workspaceRelativePath: string;
      fileName: string;
    }
  | {
      status: 'not_found' | 'deleted' | 'too_large' | 'unreachable';
      content: string;
    };

type PreparedAttachment = {
  status: 'ready';
  storageRef: string;
  fileName: string;
  contentType?: string;
  sizeBytes: number;
};

type StaleAttachment = { status: 'stale' };

export interface AttachmentResolverDeps {
  repository: MessageAttachmentRepository;
  fetcher: HistoricalAttachmentFetcher;
  materializationRoot: string;
  workspaceRoots: () => readonly string[];
  writeAttachment?: ProviderAttachmentWriter;
  createStorageRef?: (fileName: string) => string;
  now?: () => string;
  openTimeoutMs?: number;
}

export class AttachmentResolver {
  private readonly inFlight = new Map<string, Promise<AttachmentOpenResult>>();
  private readonly writeAttachment: ProviderAttachmentWriter;
  private readonly createStorageRef: (fileName: string) => string;
  private readonly now: () => string;
  private readonly openTimeoutMs: number;

  constructor(private readonly deps: AttachmentResolverDeps) {
    this.writeAttachment = deps.writeAttachment ?? providerAttachmentWriter;
    this.createStorageRef =
      deps.createStorageRef ?? createProviderAttachmentStorageRef;
    this.now = deps.now ?? nowIso;
    this.openTimeoutMs = deps.openTimeoutMs ?? ATTACHMENT_OPEN_TIMEOUT_MS;
  }

  async open(input: {
    attachmentId: string;
    appId: string;
    providerAccountId: string;
    conversationJid: string;
    threadId?: string;
    mode?: 'view' | 'materialize';
    workspaceRoot?: string;
  }): Promise<AttachmentOpenResult> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<AttachmentOpenResult>((resolve) => {
      timeout = setTimeout(() => {
        abortController.abort();
        const failure = classifyAndLogAttachmentFailure({
          evidence: { kind: 'timeout' },
          provider: 'unknown',
          providerAccountId: input.providerAccountId,
          conversationJid: input.conversationJid,
          attachmentId: input.attachmentId,
          elapsedMs: Date.now() - startedAt,
        });
        resolve({
          status: 'unreachable',
          content: failure.content,
        });
      }, this.openTimeoutMs);
    });
    return Promise.race([
      this.openWithinDeadline(input, abortController.signal, 1, startedAt),
      deadline,
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
      abortController.abort();
    });
  }

  private async openWithinDeadline(
    input: Parameters<AttachmentResolver['open']>[0],
    signal: AbortSignal,
    staleRetriesRemaining: number,
    startedAt: number,
  ): Promise<AttachmentOpenResult> {
    const attachment = await this.deps.repository.getResolvableAttachment(
      input.attachmentId,
    );
    if (signal.aborted) {
      return {
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      };
    }
    if (
      !attachment ||
      attachment.appId !== input.appId ||
      attachment.providerAccountId !== input.providerAccountId ||
      !input.conversationJid ||
      attachment.conversationJid !== input.conversationJid
    ) {
      return {
        status: 'not_found',
        content: ATTACHMENT_NOT_FOUND_COPY,
      };
    }
    if (attachment.deletedAt) {
      if (
        attachment.storageRef &&
        isProviderAttachmentStorageRef(attachment.storageRef)
      ) {
        await this.deps.repository.reclaimTombstonedStorageRef({
          attachmentId: attachment.id,
          messageId: attachment.messageId,
          storageRef: attachment.storageRef,
        });
      }
      return { status: 'deleted', content: ATTACHMENT_DELETED_COPY };
    }
    if (
      input.mode === 'materialize' &&
      attachment.storageRef &&
      isWorkspaceLocalAttachmentStorageRef(attachment.storageRef)
    ) {
      // Short-circuit only when the workspace file actually exists; a stale
      // or relocated local ref must fall through to provider-fetch recovery
      // (rows carrying provider_fetch metadata can re-materialize).
      const existing = input.workspaceRoot
        ? await workspaceLocalRegularFile(
            input.workspaceRoot,
            attachment.storageRef,
          )
        : false;
      if (existing) {
        return {
          status: 'already_in_workspace',
          content: 'Attachment is already in the workspace.',
          workspaceRelativePath: attachment.storageRef,
          fileName:
            attachment.fileName?.trim() ||
            attachment.storageRef.split('/').at(-1) ||
            'attachment.bin',
        };
      }
    }
    if (
      attachment.storageRef &&
      isProviderAttachmentStorageRef(attachment.storageRef)
    ) {
      const opened = await this.openMaterialized(
        attachment,
        attachment.storageRef,
        input.mode,
      );
      if (opened.status === 'opened') return opened;
      if (!attachment.providerFetch) return opened;
      // Safe reclamation needs both sides: cleanup rechecks under the message
      // lock so it never deletes live bytes, and a row that later resurrects a
      // dead ref falls through here to fetch and CAS a fresh ref.
    }
    if (!attachment.providerFetch) {
      return {
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      };
    }

    const inFlightKey = [
      attachment.id,
      attachment.messageId,
      attachment.appId,
      attachment.providerAccountId,
      attachment.conversationId,
      attachment.providerFetch.provider,
      attachment.providerFetch.kind,
      attachment.providerFetch.id,
      input.mode ?? 'view',
    ].join('\0');
    const existing = this.inFlight.get(inFlightKey);
    if (existing) return existing;

    const pending = this.fetchAndMaterialize(
      attachment,
      input,
      signal,
      staleRetriesRemaining,
      startedAt,
    );
    this.inFlight.set(inFlightKey, pending);
    const clearPending = () => {
      if (this.inFlight.get(inFlightKey) === pending) {
        this.inFlight.delete(inFlightKey);
      }
    };
    signal.addEventListener('abort', clearPending, { once: true });
    try {
      return await pending;
    } finally {
      signal.removeEventListener('abort', clearPending);
      clearPending();
    }
  }

  private async fetchAndMaterialize(
    attachment: ResolvableMessageAttachment,
    input: Parameters<AttachmentResolver['open']>[0],
    signal: AbortSignal,
    staleRetriesRemaining: number,
    startedAt: number,
  ): Promise<AttachmentOpenResult> {
    const prepared = await this.fetchAndPrepare(
      attachment,
      input.threadId,
      signal,
      input,
      startedAt,
    );
    if (prepared.status === 'stale') {
      return this.retryStaleAttachment(
        input,
        signal,
        staleRetriesRemaining,
        startedAt,
      );
    }
    if (prepared.status !== 'ready') return prepared;
    if (signal.aborted) {
      await this.removeMaterialized(prepared.storageRef);
      return {
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      };
    }

    let persisted: Awaited<
      ReturnType<MessageAttachmentRepository['setStorageRefIfAbsent']>
    >;
    try {
      persisted = await this.deps.repository.setStorageRefIfAbsent({
        attachmentId: attachment.id,
        expectedMessageId: attachment.messageId,
        expectedAppId: attachment.appId,
        expectedConversationId: attachment.conversationId,
        expectedProviderAccountId: attachment.providerAccountId,
        expectedProviderFetch: attachment.providerFetch!,
        ...(attachment.storageRef
          ? { expectedStorageRef: attachment.storageRef }
          : {}),
        storageRef: prepared.storageRef,
        fileName: prepared.fileName,
        ...(prepared.contentType ? { contentType: prepared.contentType } : {}),
        sizeBytes: prepared.sizeBytes,
      });
    } catch (error) {
      await this.removeMaterialized(prepared.storageRef).catch(() => undefined);
      throw error;
    }
    if (persisted.status !== 'materialized') {
      await this.removeMaterialized(prepared.storageRef);
      if (persisted.status === 'stale') {
        return this.retryStaleAttachment(
          input,
          signal,
          staleRetriesRemaining,
          startedAt,
        );
      }
      return persisted.status === 'deleted'
        ? { status: 'deleted', content: ATTACHMENT_DELETED_COPY }
        : { status: 'not_found', content: ATTACHMENT_NOT_FOUND_COPY };
    }
    if (persisted.attachment.storageRef !== prepared.storageRef) {
      await this.removeMaterialized(prepared.storageRef);
    }
    if (signal.aborted) {
      return {
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      };
    }
    return this.openMaterialized(
      {
        ...attachment,
        fileName: persisted.attachment.fileName ?? prepared.fileName,
        contentType: persisted.attachment.contentType ?? prepared.contentType,
        sizeBytes: persisted.attachment.sizeBytes ?? prepared.sizeBytes,
      },
      persisted.attachment.storageRef,
      input.mode,
    );
  }

  private async fetchAndPrepare(
    attachment: ResolvableMessageAttachment,
    threadId: string | undefined,
    signal: AbortSignal,
    input: Parameters<AttachmentResolver['open']>[0],
    startedAt: number,
  ): Promise<PreparedAttachment | AttachmentOpenResult | StaleAttachment> {
    const fetched = await this.deps.fetcher.fetchHistoricalAttachment({
      identity: attachment.providerFetch!,
      conversationJid: attachment.conversationJid,
      ...(threadId ? { threadId } : {}),
      providerAccountId: attachment.providerAccountId,
      signal,
    });
    if (fetched.status === 'deleted') {
      if (signal.aborted) {
        return {
          status: 'unreachable',
          content: ATTACHMENT_UNREACHABLE_COPY,
        };
      }
      const tombstone = await this.deps.repository.setDeletedAt({
        attachmentId: attachment.id,
        expectedMessageId: attachment.messageId,
        expectedAppId: attachment.appId,
        expectedConversationId: attachment.conversationId,
        expectedProviderAccountId: attachment.providerAccountId,
        expectedProviderFetch: attachment.providerFetch!,
        deletedAt: this.now(),
      });
      if (signal.aborted) {
        return {
          status: 'unreachable',
          content: ATTACHMENT_UNREACHABLE_COPY,
        };
      }
      if (tombstone.stale) return { status: 'stale' };
      if (!tombstone.tombstoned) {
        return {
          status: 'not_found',
          content: ATTACHMENT_NOT_FOUND_COPY,
        };
      }
      const failure = this.classifyFailure(
        attachment,
        input,
        { kind: 'deleted' },
        startedAt,
      );
      return { status: 'deleted', content: failure.content };
    }
    if (fetched.status === 'unreachable') {
      if (signal.aborted) {
        return {
          status: 'unreachable',
          content: ATTACHMENT_UNREACHABLE_COPY,
        };
      }
      const providerStatus =
        fetched.providerStatus === undefined
          ? {}
          : { providerStatus: fetched.providerStatus };
      const evidence: AttachmentFailureEvidence =
        fetched.reason === 'missing_scope'
          ? {
              kind: 'provider_unreachable',
              reason: fetched.reason,
              scope: fetched.scope,
              ...providerStatus,
            }
          : {
              kind: 'provider_unreachable',
              reason: fetched.reason,
              ...providerStatus,
            };
      const failure = this.classifyFailure(
        attachment,
        input,
        evidence,
        startedAt,
      );
      return {
        status: 'unreachable',
        content: failure.content,
      };
    }

    if (signal.aborted) {
      await historicalAttachmentReader(fetched.content)
        ?.cancel(signal.reason)
        .catch(() => undefined);
      return {
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      };
    }

    const fileName =
      fetched.fileName?.trim() ||
      attachment.fileName?.trim() ||
      'attachment.bin';
    const contentType = fetched.contentType ?? attachment.contentType;
    const storageRef = this.createStorageRef(fileName);
    const reader = historicalAttachmentReader(fetched.content);
    let streamConsumed = false;
    let cancellation: Promise<void> | undefined;
    const cancelIncompleteStream = (): Promise<void> => {
      if (!reader || streamConsumed) return Promise.resolve();
      cancellation ??= reader.cancel(signal.reason).catch(() => undefined);
      return cancellation;
    };
    const cancelOnAbort = () => {
      void cancelIncompleteStream();
    };
    signal.addEventListener('abort', cancelOnAbort, { once: true });
    if (signal.aborted) cancelOnAbort();
    let writeResult: Awaited<ReturnType<ProviderAttachmentWriter>>;
    try {
      writeResult = await materializeProviderAttachment({
        materializationRoot: this.deps.materializationRoot,
        workspaceRoots: this.deps.workspaceRoots(),
        storageRef,
        content: reader
          ? {
              async read() {
                const chunk = await reader.read();
                streamConsumed = chunk.done;
                return chunk;
              },
            }
          : fetched.content,
        maxBytes: ATTACHMENT_MAX_BYTES,
        writer: this.writeAttachment,
      });
    } finally {
      signal.removeEventListener('abort', cancelOnAbort);
      await cancelIncompleteStream();
    }
    if (signal.aborted) {
      if (writeResult.status === 'written') {
        await this.removeMaterialized(storageRef);
      }
      return {
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      };
    }
    if (writeResult.status === 'too-large') {
      if (signal.aborted) {
        return {
          status: 'unreachable',
          content: ATTACHMENT_UNREACHABLE_COPY,
        };
      }
      const failure = this.classifyFailure(
        attachment,
        input,
        { kind: 'too_large' },
        startedAt,
      );
      return {
        status: 'too_large',
        content: failure.content,
      };
    }
    return {
      status: 'ready',
      storageRef,
      fileName,
      ...(contentType ? { contentType } : {}),
      sizeBytes: writeResult.bytes,
    };
  }

  private async openMaterialized(
    attachment: ResolvableMessageAttachment,
    storageRef: string,
    mode: 'view' | 'materialize' = 'view',
  ): Promise<AttachmentOpenResult> {
    if (!isProviderAttachmentStorageRef(storageRef)) {
      return {
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      };
    }
    const opened = await readProviderAttachment({
      materializationRoot: this.deps.materializationRoot,
      workspaceRoots: this.deps.workspaceRoots(),
      storageRef,
      attachment,
      mode,
    }).catch(() => ({ status: 'missing' as const }));
    if (opened.status === 'missing') {
      return {
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      };
    }
    return {
      status: 'opened',
      content: opened.content,
      ...(opened.image ? { image: opened.image } : {}),
      materializedPath: opened.materializedPath,
      storageRef,
      fileName:
        attachment.fileName?.trim() ||
        storageRef.split('/').at(-1) ||
        'attachment.bin',
    };
  }

  private retryStaleAttachment(
    input: Parameters<AttachmentResolver['open']>[0],
    signal: AbortSignal,
    staleRetriesRemaining: number,
    startedAt: number,
  ): Promise<AttachmentOpenResult> {
    if (staleRetriesRemaining <= 0 || signal.aborted) {
      return Promise.resolve({
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      });
    }
    return this.openWithinDeadline(
      input,
      signal,
      staleRetriesRemaining - 1,
      startedAt,
    );
  }

  private classifyFailure(
    attachment: ResolvableMessageAttachment,
    input: Parameters<AttachmentResolver['open']>[0],
    evidence: AttachmentFailureEvidence,
    startedAt: number,
  ) {
    return classifyAndLogAttachmentFailure({
      evidence,
      provider: attachment.providerFetch?.provider ?? 'unknown',
      providerAccountId: input.providerAccountId,
      conversationJid: input.conversationJid,
      attachmentId: input.attachmentId,
      elapsedMs: Date.now() - startedAt,
    });
  }

  private removeMaterialized(storageRef: string): Promise<void> {
    return removeProviderAttachment({
      materializationRoot: this.deps.materializationRoot,
      workspaceRoots: this.deps.workspaceRoots(),
      storageRef,
    });
  }
}

function isWorkspaceLocalAttachmentStorageRef(storageRef: string): boolean {
  return (
    storageRef.startsWith('attachments/') &&
    storageRef.length > 'attachments/'.length &&
    !storageRef.includes('\\') &&
    !storageRef.split('/').includes('..')
  );
}

function historicalAttachmentReader(
  content: Uint8Array | HistoricalAttachmentReader,
): HistoricalAttachmentReader | undefined {
  return 'read' in content ? content : undefined;
}
