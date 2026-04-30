import { threadId } from './context.js';

export function resolveSchedulerThreadArg(
  requestedThreadId: string | undefined,
  useAmbientDefault: boolean,
): { threadId?: string; error?: string } {
  if (requestedThreadId !== undefined) {
    const requested = requestedThreadId.trim();
    if (requested && requested !== threadId) {
      return {
        error:
          'thread_id can only target the current thread/topic for this agent run.',
      };
    }
    return { threadId: requested };
  }
  return useAmbientDefault && threadId ? { threadId } : {};
}

export function normalizeExecutionMode(
  executionMode: unknown,
  serialize: unknown,
): 'parallel' | 'serialized' {
  if (executionMode === 'serialized') return 'serialized';
  if (executionMode === 'parallel') return 'parallel';
  if (typeof serialize === 'boolean') {
    return serialize ? 'serialized' : 'parallel';
  }
  return 'parallel';
}
