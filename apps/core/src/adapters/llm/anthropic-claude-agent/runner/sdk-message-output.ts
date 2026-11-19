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

export function hasTopLevelToolUse(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const record = message as {
    message?: { content?: unknown };
    parent_tool_use_id?: unknown;
  };
  if (typeof record.parent_tool_use_id === 'string') return false;
  const content = record.message?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        part &&
        typeof part === 'object' &&
        ((part as { type?: unknown }).type === 'tool_use' ||
          (part as { type?: unknown }).type === 'server_tool_use' ||
          (part as { type?: unknown }).type === 'mcp_tool_use'),
    )
  );
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
