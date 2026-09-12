import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
import type { DeepAgentPartialUsage } from '../runner/stream-normalizer-partial-usage.js';

export function partialUsageError(
  partialUsage: DeepAgentPartialUsage,
  newSessionId: string,
): RunnerOutputFrame {
  return {
    status: 'error',
    result: null,
    error: partialUsage.message,
    newSessionId,
    usage: partialUsage.usage,
    usageEventId: partialUsage.usageEventId,
    contextUsage: partialUsage.contextUsage,
  };
}

export function structuredOutputError(
  error: unknown,
  newSessionId: string,
): RunnerOutputFrame & { structuredOutputValidationFailure: true } {
  const detail = error instanceof Error ? ` ${error.message}` : '';
  return {
    status: 'error',
    result: null,
    error: `Inline structured output failed schema validation.${detail}`,
    structuredOutputValidationFailure: true,
    newSessionId,
  };
}

export function abortedOutput(newSessionId?: string): RunnerOutputFrame {
  return {
    status: 'error',
    result: null,
    error: 'Inline DeepAgents lane aborted.',
    ...(newSessionId ? { newSessionId } : {}),
  };
}
