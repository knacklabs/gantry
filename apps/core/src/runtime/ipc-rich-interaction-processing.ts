import fs from 'fs';

import {
  RICH_INTERACTION_NATIVE_FALLBACK_TEXT,
  type RichInteractionRequest,
} from '../domain/types.js';
import type { IpcDeps } from './ipc-domain-types.js';
import { archiveIpcErrorFile } from './ipc-filesystem.js';
import type { IpcInteractionLogger } from './ipc-interaction-processing.js';

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
    const delivered = input.deps.renderRichInteraction
      ? await input.deps.renderRichInteraction(
          targetJid,
          input.request,
          input.request.providerAccountId
            ? { providerAccountId: input.request.providerAccountId }
            : undefined,
        )
      : false;
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
