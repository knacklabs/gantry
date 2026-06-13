import type { NewMessage } from '../domain/types.js';
import type { SessionCommandDeps } from './session-commands.js';

type ManualCommandKind = 'digest_session';

function isMemoryExtractionTimeout(message: string): boolean {
  return /memory boundary extraction.*(?:deadline exceeded|timed out|aborted)/i.test(
    message,
  );
}

export async function handleManualExtractionCommand(input: {
  kind: ManualCommandKind;
  deps: SessionCommandDeps;
  cmdMsg: Pick<NewMessage, 'timestamp' | 'id'>;
  sanitizeErrorText: (text: string) => string;
}): Promise<{ handled: true; success: true }> {
  const { deps, cmdMsg, sanitizeErrorText } = input;
  deps.advanceCursor(cmdMsg);

  if (!deps.collectCurrentSessionMemory) {
    await deps.sendMessage('/digest-session is unavailable in this runtime.');
    return { handled: true, success: true };
  }
  try {
    const result = await deps.collectCurrentSessionMemory({
      excludeMessageIds: [cmdMsg.id],
    });
    await deps.sendMessage(
      `Digest processed. New digest: ${result.digestCreated ? 'yes' : 'no new customer turns'}. Memory facts saved: ${result.saved}.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isMemoryExtractionTimeout(message)) {
      await deps.sendMessage(
        'Digest processed. New digest: unknown. Memory facts saved: 0. Memory extraction timed out; continue with /extract-leads-queries.',
      );
      return { handled: true, success: true };
    }
    await deps.sendMessage(
      `/digest-session failed: ${sanitizeErrorText(message)}`,
    );
  }
  return { handled: true, success: true };
}
