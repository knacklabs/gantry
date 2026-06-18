export async function handleFailure(input: {
  outputSentToUser: boolean;
  groupName: string;
  queueJid: string;
  previousCursor: string;
  deps: {
    setCursor: (chatJid: string, timestamp: string) => void;
    saveState: () => Promise<void> | void;
  };
  isShuttingDown?: () => boolean;
  logger: {
    warn(payload: Record<string, unknown>, message: string): void;
  };
}): Promise<boolean> {
  if (input.outputSentToUser) {
    input.logger.warn(
      { group: input.groupName },
      'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
    );
    return true;
  }
  input.deps.setCursor(input.queueJid, input.previousCursor);
  await input.deps.saveState();
  input.logger.warn(
    { group: input.groupName },
    'Agent error, rolled back message cursor for retry',
  );
  return false;
}

export function resetGroupStreamingForTurn(input: {
  chatJid: string;
  groupName: string;
  channelRuntime: { resetStreaming(jid: string): void };
  logger: { debug(payload: Record<string, unknown>, message: string): void };
}): void {
  try {
    input.channelRuntime.resetStreaming(input.chatJid);
  } catch (err) {
    input.logger.debug(
      { err, group: input.groupName },
      'Failed to reset channel streaming state before processing',
    );
  }
}

export async function waitOutput(input: {
  wait: () => Promise<void>;
  getError: () => unknown;
  hadError: boolean;
  groupName: string;
  logger: {
    error(payload: Record<string, unknown>, message: string): void;
  };
}): Promise<boolean> {
  await input.wait();
  const err = input.getError();
  if (!err) return input.hadError;
  input.logger.error(
    { group: input.groupName, err },
    'Agent output callback failed',
  );
  return true;
}
