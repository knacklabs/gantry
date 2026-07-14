import { sendCoreMessage } from '../application/core-tools/send-message.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { ParsedIpcMessage } from './ipc-parsing.js';

export async function deliverIpcMessage(input: {
  deps: IpcDeps;
  sourceAgentFolder: string;
  data: ParsedIpcMessage;
  targetJid: string;
  providerAccountId?: string;
}): Promise<void> {
  await sendCoreMessage({
    deps: input.deps,
    context: {
      appId: input.data.appId,
      sourceAgentFolder: input.sourceAgentFolder,
      targetJid: input.targetJid,
      threadId: input.data.threadId,
      providerAccountId: input.providerAccountId,
    },
    message: {
      text: input.data.text,
      sender: input.data.sender,
      files: input.data.files,
    },
  });
}
