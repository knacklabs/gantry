import type {
  PendingInteractionKind,
  PendingInteractionRepository,
} from '../../domain/ports/worker-coordination.js';

const DEFAULT_APP_ID = 'default';

type PromptBindingBackend = {
  repository: PendingInteractionRepository;
  warn?: (context: Record<string, unknown>, message: string) => void;
};

let backend: PromptBindingBackend | null = null;

export function configurePendingInteractionPromptBinding(
  next: PromptBindingBackend | null,
): void {
  backend = next;
}

function idempotencyKey(input: {
  kind: PendingInteractionKind;
  sourceAgentFolder: string;
  requestId: string;
}): string {
  return [input.kind, input.sourceAgentFolder, input.requestId].join(':');
}

function sourceAgentFolderFromPayload(
  payload: Record<string, unknown> | undefined,
): string | null {
  if (typeof payload?.sourceAgentFolder === 'string')
    return payload.sourceAgentFolder;
  const request = payload?.request;
  if (!request || typeof request !== 'object') return null;
  if (!('sourceAgentFolder' in request)) return null;
  return typeof request.sourceAgentFolder === 'string'
    ? request.sourceAgentFolder
    : null;
}

export async function bindPendingPermissionInteractionMessage(input: {
  sourceAgentFolder: string;
  requestId: string;
  externalMessageId: string;
  appId?: string | null;
  provider?: string | null;
  conversationId?: string | null;
  threadId?: string | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  const key = idempotencyKey({
    kind: 'permission',
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.requestId,
  });
  try {
    const pending = (
      await active.repository.listPendingInteractions({
        appId: input.appId || DEFAULT_APP_ID,
      })
    ).find(
      (interaction) =>
        interaction.kind === 'permission' &&
        interaction.status === 'pending' &&
        interaction.idempotencyKey === key,
    );
    if (!pending) return false;
    return await active.repository.updatePendingInteractionPayload({
      idempotencyKey: key,
      payload: {
        ...pending.payload,
        externalPromptMessageId: input.externalMessageId,
        ...(input.provider ? { externalPromptProvider: input.provider } : {}),
        ...(input.conversationId
          ? { externalPromptConversationId: input.conversationId }
          : {}),
        ...(input.threadId ? { externalPromptThreadId: input.threadId } : {}),
      },
    });
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId },
      'Failed to bind pending permission interaction to provider message',
    );
    return false;
  }
}

export interface DurablePermissionPromptMessageContext {
  requestId?: string;
  sourceAgentFolder: string;
  targetJid: string | null;
  decisionPolicy: string | null;
}

export async function findDurablePermissionInteractionByPromptMessage(input: {
  provider: string;
  conversationId: string;
  externalMessageId: string;
  threadId?: string | null;
  appId?: string | null;
}): Promise<DurablePermissionPromptMessageContext | null> {
  const active = backend;
  if (!active) return null;
  try {
    const pending = (
      await active.repository.listPendingInteractions({
        appId: input.appId || DEFAULT_APP_ID,
      })
    ).find((interaction) => {
      if (interaction.kind !== 'permission' || interaction.status !== 'pending')
        return false;
      const payload = interaction.payload;
      if (payload.externalPromptProvider !== input.provider) return false;
      if (payload.externalPromptConversationId !== input.conversationId)
        return false;
      if (payload.externalPromptMessageId !== input.externalMessageId)
        return false;
      return (
        !input.threadId || payload.externalPromptThreadId === input.threadId
      );
    });
    const sourceAgentFolder = sourceAgentFolderFromPayload(pending?.payload);
    if (!pending || !sourceAgentFolder) return null;
    return {
      requestId:
        typeof pending.payload.requestId === 'string'
          ? pending.payload.requestId
          : undefined,
      sourceAgentFolder,
      targetJid:
        typeof pending.payload.conversationId === 'string'
          ? pending.payload.conversationId
          : null,
      decisionPolicy:
        typeof pending.payload.decisionPolicy === 'string'
          ? pending.payload.decisionPolicy
          : null,
    };
  } catch (err) {
    active.warn?.(
      { err, externalMessageId: input.externalMessageId },
      'Failed to find durable permission interaction by provider message',
    );
    return null;
  }
}
