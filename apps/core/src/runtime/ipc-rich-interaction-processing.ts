import fs from 'fs';

import {
  RICH_INTERACTION_NATIVE_FALLBACK_TEXT,
  type RichInteractionRequest,
} from '../domain/types.js';
import type { IpcDeps } from './ipc-domain-types.js';
import { archiveIpcErrorFile } from './ipc-filesystem.js';
import type { IpcInteractionLogger } from './ipc-interaction-processing.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';

export async function processRichInteractionIpc(input: {
  request: RichInteractionRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
  ipcBaseDir: string;
  file: string;
  claimedPath: string;
  logger: IpcInteractionLogger;
}): Promise<void> {
  try {
    const targetJid = input.request.targetJid;
    if (!targetJid) throw new Error('Rich interaction target is missing');
    const options = input.request.providerAccountId
      ? { providerAccountId: input.request.providerAccountId }
      : undefined;
    const progress = progressRender(input.request);
    const progressDelivered =
      progress && input.deps.renderAgentTodo
        ? await input.deps.renderAgentTodo(targetJid, progress, options)
        : false;
    const delivered =
      progressDelivered ||
      (input.deps.renderRichInteraction
        ? await input.deps.renderRichInteraction(
            targetJid,
            input.request,
            options,
          )
        : false);
    if (!delivered) {
      await sendRichInteractionFallback(input.deps, input.request);
    }
    fs.unlinkSync(input.claimedPath);
  } catch (err) {
    input.logger.error(
      {
        file: input.file,
        sourceAgentFolder: input.sourceAgentFolder,
        requestId: input.request.requestId,
        err,
      },
      'Error processing rich interaction IPC request',
    );
    try {
      await sendRichInteractionFallback(input.deps, input.request);
      fs.unlinkSync(input.claimedPath);
    } catch {
      archiveIpcErrorFile(
        input.ipcBaseDir,
        input.sourceAgentFolder,
        input.file,
        input.claimedPath,
      );
    }
  }
}

function progressRender(
  request: RichInteractionRequest,
): AgentTodoRender | undefined {
  if (request.descriptor.rich?.kind !== 'progress') return undefined;
  const payload = request.descriptor.rich.payload ?? {};
  const label = typeof payload.label === 'string' ? payload.label.trim() : '';
  const value =
    typeof payload.value === 'number' && Number.isFinite(payload.value)
      ? `${payload.value}%`
      : '';
  const detail = [label, value, payload.done === true ? 'done' : '']
    .filter(Boolean)
    .join(' — ');
  const title = request.descriptor.title.trim();
  const summary = `${title}${detail ? `… ${detail}` : '…'}`;
  return {
    summary,
    items: [],
    status: payload.done === true ? 'done' : 'running',
    threadId: request.threadId ?? null,
    updatedAt: new Date().toISOString(),
    cardKind: 'progress',
  };
}

async function sendRichInteractionFallback(
  deps: IpcDeps,
  request: RichInteractionRequest,
): Promise<void> {
  if (!request.targetJid) return;
  await deps.sendMessage(
    request.targetJid,
    `${RICH_INTERACTION_NATIVE_FALLBACK_TEXT}\n\n${request.descriptor.rich?.fallbackText ?? request.descriptor.fallbackText ?? ''}`.trim(),
    {
      ...(request.threadId ? { threadId: request.threadId } : {}),
      ...(request.providerAccountId
        ? { providerAccountId: request.providerAccountId }
        : {}),
    },
  );
}
