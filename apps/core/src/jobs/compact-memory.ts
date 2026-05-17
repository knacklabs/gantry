import type {
  MemoryBoundaryDefaultScope,
  SessionMemoryCollector,
} from '../domain/ports/session-memory-collector.js';

type JobMemoryLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

const MEMORY_COLLECTION_TIMEOUT_MS = 10_000;

export async function collectCompactBoundaryMemory(input: {
  compactBoundary?: boolean;
  agentSessionId?: string;
  collectMemory?: SessionMemoryCollector;
  defaultScope?: MemoryBoundaryDefaultScope;
  logger: JobMemoryLogger;
  context?: Record<string, unknown>;
}): Promise<void> {
  if (!input.compactBoundary || !input.agentSessionId || !input.collectMemory) {
    return;
  }
  try {
    const result = await withMemoryCollectionTimeout(
      input.collectMemory({
        agentSessionId: input.agentSessionId,
        trigger: 'precompact',
        ...(input.defaultScope ? { defaultScope: input.defaultScope } : {}),
      }),
    );
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
  defaultScope?: MemoryBoundaryDefaultScope;
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
    const result = await withMemoryCollectionTimeout(
      input.collectMemory({
        agentSessionId: input.agentSessionId,
        trigger: 'session-end',
        ...(input.defaultScope ? { defaultScope: input.defaultScope } : {}),
        additionalTurns,
      }),
    );
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

async function withMemoryCollectionTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Memory collection timed out after ${MEMORY_COLLECTION_TIMEOUT_MS}ms`,
            ),
          );
        }, MEMORY_COLLECTION_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
