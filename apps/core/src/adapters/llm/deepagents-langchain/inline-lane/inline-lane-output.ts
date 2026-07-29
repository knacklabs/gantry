import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';

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
