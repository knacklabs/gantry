import { describe, expect, it } from 'vitest';

import {
  bindCallerResolvedToolInput,
  callerResolvedToolFailureCode,
  resolveCallerResolvedRunId,
  resolveCallerResolvedToolInputSchema,
} from '@core/jobs/ipc-caller-resolved-tool-handler.js';

describe('caller-resolved tool run correlation', () => {
  it('uses the signed request run id when present', () => {
    expect(
      resolveCallerResolvedRunId({
        runId: 'run-direct',
        parentTaskId: 'task-child',
        sandboxRunId: 'run-policy',
      }),
    ).toBe('run-direct');
  });

  it('inherits the host policy run only for an active delegated child', () => {
    expect(
      resolveCallerResolvedRunId({
        parentTaskId: 'task-child',
        sandboxRunId: 'run-policy',
      }),
    ).toBe('run-policy');
    expect(
      resolveCallerResolvedRunId({ sandboxRunId: 'run-policy' }),
    ).toBeUndefined();
  });

  it('falls back to the durable parent task run only for a delegated child', () => {
    expect(
      resolveCallerResolvedRunId({
        parentTaskId: 'task-child',
        parentTaskRunId: 'run-parent',
      }),
    ).toBe('run-parent');
    expect(
      resolveCallerResolvedRunId({ parentTaskRunId: 'run-parent' }),
    ).toBeUndefined();
  });
});

describe('caller-resolved tool input contracts', () => {
  it('uses the declared input schema for ordinary caller-resolved tools', () => {
    const declared = { type: 'object', required: ['value'] };
    expect(
      resolveCallerResolvedToolInputSchema({
        definitionSchema: declared,
        isCompletionGate: false,
      }),
    ).toBe(declared);
  });

  it('validates the internal completion-gate request instead of the agent response', () => {
    expect(
      resolveCallerResolvedToolInputSchema({ isCompletionGate: true }),
    ).toEqual({
      type: 'object',
      properties: {
        completionAttempt: { type: 'integer', minimum: 1 },
        proposedResult: {},
      },
      required: ['completionAttempt', 'proposedResult'],
      additionalProperties: false,
    });
  });
});

describe('caller-resolved tool failure classification', () => {
  it('separates interaction expiry from recipe and generic tool failures', () => {
    expect(
      callerResolvedToolFailureCode(
        new Error('Caller tool interaction expired.'),
      ),
    ).toBe('interaction_timeout');
    expect(
      callerResolvedToolFailureCode(
        new Error('Caller tool interaction cancelled.'),
      ),
    ).toBe('interaction_cancelled');
    expect(callerResolvedToolFailureCode(new Error('upstream failed'))).toBe(
      'caller_tool_failed',
    );
  });
});

describe('caller-resolved trusted recipe identity', () => {
  const recipeSchema = {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      attemptId: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['requestId', 'attemptId', 'reason'],
    additionalProperties: false,
  };

  it('canonicalizes model-supplied request and attempt typos from trusted context', () => {
    expect(
      bindCallerResolvedToolInput({
        toolInput: {
          requestId: 'model-request-typo',
          attemptId: 'model-attempt-typo',
          reason: 'Automatic attempts exhausted.',
        },
        inputSchema: recipeSchema,
        trustedContext: {
          requestId: 'trusted-request-1',
          attemptId: 'trusted-attempt-1',
        },
      }),
    ).toEqual({
      ok: true,
      toolInput: {
        requestId: 'trusted-request-1',
        attemptId: 'trusted-attempt-1',
        reason: 'Automatic attempts exhausted.',
      },
    });
  });

  it('rejects a declared identity when trusted context is incomplete', () => {
    expect(
      bindCallerResolvedToolInput({
        toolInput: {
          requestId: 'model-request',
          attemptId: 'model-attempt',
          reason: 'Automatic attempts exhausted.',
        },
        inputSchema: recipeSchema,
        trustedContext: { requestId: 'trusted-request-1' },
      }),
    ).toEqual({
      ok: false,
      missing: ['attemptId'],
    });
  });

  it('does not inject trusted identity into unrelated tool schemas', () => {
    const toolInput = { value: 'unchanged' };
    expect(
      bindCallerResolvedToolInput({
        toolInput,
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        trustedContext: {
          requestId: 'trusted-request-1',
          attemptId: 'trusted-attempt-1',
        },
      }),
    ).toEqual({ ok: true, toolInput });
  });
});
