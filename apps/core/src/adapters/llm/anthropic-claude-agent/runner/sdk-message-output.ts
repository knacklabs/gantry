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
): string | null {
  const failure = sdkResultFailureMessage(message);
  if (failure) throw new Error(failure);
  if (responseSchema) {
    const structured =
      message && typeof message === 'object'
        ? (message as { structured_output?: unknown }).structured_output
        : undefined;
    if (structured === undefined) {
      throw new Error(
        'Claude SDK returned success without validated structured output.',
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
