import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';

type JobMemoryLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export async function collectCompactBoundaryMemory(input: {
  compactBoundary?: boolean;
  agentSessionId?: string;
  collectMemory?: SessionMemoryCollector;
  logger: JobMemoryLogger;
  context?: Record<string, unknown>;
}): Promise<void> {
  if (!input.compactBoundary || !input.agentSessionId || !input.collectMemory) {
    return;
  }
  try {
    const result = await input.collectMemory({
      agentSessionId: input.agentSessionId,
      trigger: 'precompact',
    });
    input.logger.info(
      {
        ...input.context,
        agentSessionId: input.agentSessionId,
        saved: result.saved,
      },
      'Collected durable memory at SDK compact boundary',
    );
  } catch (err) {
    input.logger.warn(
      { ...input.context, err },
      'Failed to collect durable memory at SDK compact boundary',
    );
  }
}

export async function collectJobCompletionMemory(input: {
  agentSessionId?: string;
  collectMemory?: SessionMemoryCollector;
  prompt?: string | null;
  result?: string | null;
  logger: JobMemoryLogger;
  context?: Record<string, unknown>;
}): Promise<void> {
  const additionalTurns = [
    input.prompt ? { role: 'user' as const, text: input.prompt } : null,
    input.result ? { role: 'assistant' as const, text: input.result } : null,
  ].filter((turn): turn is { role: 'user' | 'assistant'; text: string } =>
    Boolean(turn?.text.trim()),
  );
  if (
    !input.agentSessionId ||
    !input.collectMemory ||
    additionalTurns.length === 0
  ) {
    return;
  }
  try {
    const result = await input.collectMemory({
      agentSessionId: input.agentSessionId,
      trigger: 'session-end',
      additionalTurns,
    });
    input.logger.info(
      {
        ...input.context,
        agentSessionId: input.agentSessionId,
        saved: result.saved,
      },
      'Collected durable memory after successful job run',
    );
  } catch (err) {
    input.logger.warn(
      { ...input.context, err },
      'Failed to collect durable memory after successful job run',
    );
  }
}
