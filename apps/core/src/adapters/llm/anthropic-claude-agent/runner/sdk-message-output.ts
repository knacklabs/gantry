import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';

import type { AgentFailureMetadata } from '../../../../domain/ports/async-tasks.js';

export const STRUCTURED_OUTPUT_VALIDATION_FAILURE_CODE =
  'structured_output_validation_failed' as const;
export const COMPLETION_CONTINUATION_FAILURE_CODE =
  'completion_continuation_failed' as const;
const STRUCTURED_OUTPUT_REPAIR_CANDIDATE_LIMIT = 4_096;
const responseSchemaCompiler = new Ajv({
  addUsedSchema: false,
  allErrors: true,
  strict: false,
});

export class StructuredOutputValidationError extends Error {
  readonly code = STRUCTURED_OUTPUT_VALIDATION_FAILURE_CODE;

  constructor(
    message = 'Claude SDK returned success without validated structured output.',
  ) {
    super(message);
    this.name = 'StructuredOutputValidationError';
  }
}

export class CompletionContinuationError extends Error {
  readonly code = COMPLETION_CONTINUATION_FAILURE_CODE;

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'CompletionContinuationError';
  }
}

export function isSdkStructuredOutputValidationFailure(
  message: unknown,
): boolean {
  return Boolean(
    message &&
    typeof message === 'object' &&
    (message as { subtype?: unknown }).subtype ===
      'error_max_structured_output_retries',
  );
}

export function sdkResultFailureMetadata(
  error: unknown,
): AgentFailureMetadata | undefined {
  if (error instanceof StructuredOutputValidationError) {
    return {
      type: 'execution',
      code: error.code,
      attemptedAction: 'Validate final response against response schema',
    };
  }
  if (error instanceof CompletionContinuationError) {
    return {
      type: 'execution',
      code: error.code,
      attemptedAction: 'Continue after completion gate requested more work',
    };
  }
  return undefined;
}

function resultFailureRequiresRuntimeFailure(value: string): boolean {
  const normalized = value.toLowerCase();
  const looksLikeCredentialFailure =
    normalized.includes('invalid api key') ||
    normalized.includes('external api key') ||
    normalized.includes('authentication failed') ||
    normalized.includes('failed to authenticate') ||
    normalized.includes('authentication_error') ||
    normalized.includes('invalid bearer token') ||
    normalized.includes('api error: 401');
  const looksLikeBillingFailure =
    normalized.includes('billing') ||
    normalized.includes('out of credits') ||
    normalized.includes('credit balance') ||
    normalized.includes('insufficient credit') ||
    normalized.includes('payment required');
  return looksLikeCredentialFailure || looksLikeBillingFailure;
}

export function shouldPrefixVisibleBoundary(
  previous: string,
  next: string,
): boolean {
  return Boolean(
    previous.trim() &&
    next.trim() &&
    !/\s$/.test(previous) &&
    !/^\s/.test(next),
  );
}

export function sdkResultFailureMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const resultMessage = message as {
    subtype?: string;
    is_error?: boolean;
    result?: string;
    errors?: unknown;
  };
  const errors = Array.isArray(resultMessage.errors)
    ? resultMessage.errors.filter((error): error is string => {
        return typeof error === 'string' && error.trim().length > 0;
      })
    : [];
  const text =
    typeof resultMessage.result === 'string' ? resultMessage.result : '';
  if (text && resultFailureRequiresRuntimeFailure(text)) {
    return text;
  }
  if (resultMessage.subtype && resultMessage.subtype !== 'success') {
    return errors.length > 0
      ? errors.join('; ')
      : `Claude SDK result failed with subtype ${resultMessage.subtype}`;
  }
  if (resultMessage.is_error && errors.length > 0) {
    return errors.join('; ');
  }
  return null;
}

export function topLevelAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as {
    message?: { content?: unknown };
    parent_tool_use_id?: unknown;
  };
  if (typeof record.parent_tool_use_id === 'string') return '';
  return assistantTextFromContent(record.message?.content);
}

export function sdkResultText(
  message: unknown,
  responseSchema?: Record<string, unknown>,
  validateResponse?: ValidateFunction,
): string | null {
  const failure = sdkResultFailureMessage(message);
  if (failure) {
    throw isSdkStructuredOutputValidationFailure(message)
      ? new StructuredOutputValidationError(failure)
      : new Error(failure);
  }
  if (responseSchema) {
    let structured =
      message && typeof message === 'object'
        ? (message as { structured_output?: unknown }).structured_output
        : undefined;
    if (structured === undefined && message && typeof message === 'object') {
      const result = (message as { result?: unknown }).result;
      if (typeof result === 'string') {
        try {
          structured = JSON.parse(result);
        } catch {
          // Preserve the stable missing-structured-output failure below.
        }
      }
    }
    if (structured === undefined) {
      throw new StructuredOutputValidationError();
    }
    const validate =
      validateResponse ?? compileSdkResponseSchema(responseSchema);
    if (validate?.(structured) !== true) {
      throw new StructuredOutputValidationError(
        `Claude SDK structured output failed response_schema validation: ${formatValidationErrors(validate?.errors)}`,
      );
    }
    return JSON.stringify(structured);
  }
  const result =
    message && typeof message === 'object'
      ? (message as { result?: unknown }).result
      : undefined;
  return typeof result === 'string' ? result : null;
}

export function compileSdkResponseSchema(
  responseSchema?: Record<string, unknown>,
): ValidateFunction | undefined {
  if (!responseSchema) return undefined;
  try {
    return responseSchemaCompiler.compile(responseSchema as AnySchema);
  } catch (error) {
    throw new StructuredOutputValidationError(
      `response_schema could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function sdkStructuredOutputRepairInstruction(
  error: StructuredOutputValidationError,
  message: unknown,
): string {
  const structured =
    message && typeof message === 'object'
      ? (message as { structured_output?: unknown }).structured_output
      : undefined;
  const candidate =
    structured === undefined
      ? '(no structured candidate)'
      : JSON.stringify(structured);
  const boundedCandidate =
    candidate.length <= STRUCTURED_OUTPUT_REPAIR_CANDIDATE_LIMIT
      ? candidate
      : `${candidate.slice(0, STRUCTURED_OUTPUT_REPAIR_CANDIDATE_LIMIT)}\n[truncated]`;
  return [
    'Your previous final response failed response_schema validation.',
    error.message,
    'Correct only the final structured response. Do not call tools.',
    'Previous structured response:',
    boundedCandidate,
  ].join('\n');
}

function formatValidationErrors(errors: ValidateFunction['errors']): string {
  return (
    errors
      ?.slice(0, 3)
      .map(
        (error) =>
          `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
      )
      .join('; ') || '/ is invalid'
  );
}

export function sdkStructuredOutputOptions(
  responseSchema?: Record<string, unknown>,
) {
  return responseSchema
    ? {
        outputFormat: {
          type: 'json_schema' as const,
          schema: responseSchema,
        },
      }
    : {};
}

export function hasTopLevelAssistantContent(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const record = message as {
    message?: { content?: unknown };
    parent_tool_use_id?: unknown;
  };
  if (typeof record.parent_tool_use_id === 'string') return false;
  return record.message?.content !== undefined;
}

function assistantTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('');
}
