import type { HistoricalAttachmentFetcher } from '../../domain/ports/historical-attachment-fetcher.js';
import type {
  MessageAttachmentRepository,
  ResolvableMessageAttachment,
} from '../../domain/ports/message-attachment-repository.js';
import {
  createProviderAttachmentStorageRef,
  isProviderAttachmentStorageRef,
  materializeProviderAttachment,
  providerAttachmentWriter,
  readProviderAttachment,
  removeProviderAttachment,
  type ProviderAttachmentWriter,
} from '../../shared/provider-attachment-materialization.js';
import { nowIso } from '../../shared/time/datetime.js';

export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const ATTACHMENT_OPEN_TIMEOUT_MS = 110_000;
export const ATTACHMENT_NOT_FOUND_COPY =
  "I couldn't find that attachment in this conversation.";
export const ATTACHMENT_DELETED_COPY =
  'That file was deleted from the channel.';
export const ATTACHMENT_TOO_LARGE_COPY =
  "That file is larger than 50 MiB, so I can't open it.";
export const ATTACHMENT_UNREACHABLE_COPY =
  "I can't get that file from the channel right now.";

export type AttachmentOpenResult =
  | {
      status: 'opened';
      content: string;
      materializedPath: string;
      storageRef: string;
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
  }): Promise<AttachmentOpenResult> {
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<AttachmentOpenResult>((resolve) => {
      timeout = setTimeout(() => {
        abortController.abort();
        resolve({
          status: 'unreachable',
          content: ATTACHMENT_UNREACHABLE_COPY,
        });
      }, this.openTimeoutMs);
    });
    return Promise.race([
      this.openWithinDeadline(input, abortController.signal, 1),
      deadline,
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private async openWithinDeadline(
    input: Parameters<AttachmentResolver['open']>[0],
    signal: AbortSignal,
    staleRetriesRemaining: number,
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
      return { status: 'deleted', content: ATTACHMENT_DELETED_COPY };
    }
    if (
      attachment.storageRef &&
      isProviderAttachmentStorageRef(attachment.storageRef)
    ) {
      const opened = await this.openMaterialized(
        attachment,
        attachment.storageRef,
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
    ].join('\0');
    const existing = this.inFlight.get(inFlightKey);
    if (existing) return existing;

    const pending = this.fetchAndMaterialize(
      attachment,
      input,
      signal,
      staleRetriesRemaining,
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
  ): Promise<AttachmentOpenResult> {
    const prepared = await this.fetchAndPrepare(
      attachment,
      input.threadId,
      signal,
    );
    if (prepared.status === 'stale') {
      return this.retryStaleAttachment(input, signal, staleRetriesRemaining);
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
        return this.retryStaleAttachment(input, signal, staleRetriesRemaining);
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
    );
  }

  private async fetchAndPrepare(
    attachment: ResolvableMessageAttachment,
    threadId: string | undefined,
    signal: AbortSignal,
  ): Promise<PreparedAttachment | AttachmentOpenResult | StaleAttachment> {
    const fetched = await this.deps.fetcher.fetchHistoricalAttachment({
      identity: attachment.providerFetch!,
      conversationJid: attachment.conversationJid,
      ...(threadId ? { threadId } : {}),
      providerAccountId: attachment.providerAccountId,
      signal,
    });
    if (signal.aborted) {
      return {
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      };
    }
    if (fetched.status === 'deleted') {
      const tombstone = await this.deps.repository.setDeletedAt({
        attachmentId: attachment.id,
        expectedMessageId: attachment.messageId,
        expectedAppId: attachment.appId,
        expectedConversationId: attachment.conversationId,
        expectedProviderAccountId: attachment.providerAccountId,
        expectedProviderFetch: attachment.providerFetch!,
        deletedAt: this.now(),
      });
      if (tombstone.stale) return { status: 'stale' };
      if (!tombstone.tombstoned) {
        return {
          status: 'not_found',
          content: ATTACHMENT_NOT_FOUND_COPY,
        };
      }
      return { status: 'deleted', content: ATTACHMENT_DELETED_COPY };
    }
    if (fetched.status === 'unreachable') {
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
    const writeResult = await materializeProviderAttachment({
      materializationRoot: this.deps.materializationRoot,
      workspaceRoots: this.deps.workspaceRoots(),
      storageRef,
      content: fetched.content,
      maxBytes: ATTACHMENT_MAX_BYTES,
      writer: this.writeAttachment,
    });
    if (writeResult.status === 'too-large') {
      return {
        status: 'too_large',
        content: ATTACHMENT_TOO_LARGE_COPY,
      };
    }
    if (signal.aborted) {
      await this.removeMaterialized(storageRef);
      return {
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
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
      materializedPath: opened.materializedPath,
      storageRef,
    };
  }

  private retryStaleAttachment(
    input: Parameters<AttachmentResolver['open']>[0],
    signal: AbortSignal,
    staleRetriesRemaining: number,
  ): Promise<AttachmentOpenResult> {
    if (staleRetriesRemaining <= 0 || signal.aborted) {
      return Promise.resolve({
        status: 'unreachable',
        content: ATTACHMENT_UNREACHABLE_COPY,
      });
    }
    return this.openWithinDeadline(input, signal, staleRetriesRemaining - 1);
  }

  private removeMaterialized(storageRef: string): Promise<void> {
    return removeProviderAttachment({
      materializationRoot: this.deps.materializationRoot,
      workspaceRoots: this.deps.workspaceRoots(),
      storageRef,
    });
  }
}
