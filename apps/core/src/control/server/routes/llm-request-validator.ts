export type LlmPassthroughEndpoint =
  | 'messages'
  | 'count_tokens'
  | 'chat_completions';

export type UnsupportedLlmRequestField = {
  field: string;
  message: string;
  code?: 'MAX_TOKENS_EXCEEDED';
  limit?: number;
  requested?: number;
  toolType?: string;
  value?: string;
};

const OUTPUT_TOKEN_FIELDS = ['max_tokens', 'max_completion_tokens'] as const;

const MESSAGES_PROVIDER_EXECUTION_FIELDS = ['mcp_servers', 'container'];
const CHAT_HOSTED_TOOL_FIELDS = [
  'web_search_options',
  'file_search',
  'file_search_options',
  'code_interpreter',
  'code_interpreter_options',
  'tool_resources',
  'container',
];
const CHAT_FILE_REFERENCE_FIELDS = [
  'attachments',
  'files',
  'file_ids',
  'file_id',
];
const CHAT_FILE_CONTENT_TYPES = new Set(['attachment', 'file', 'input_file']);
const SERVER_EXECUTION_BETA =
  /^(?:web[-_]search|web[-_]fetch|code[-_]execution|computer(?:[-_]use)?|bash|text[-_]editor|tool[-_]search)(?:[-_]|$)/i;

export function findUnsupportedLlmRequestField(
  endpoint: LlmPassthroughEndpoint,
  body: Record<string, unknown>,
  maxTokens?: number,
): UnsupportedLlmRequestField | null {
  const tokenLimitViolation =
    endpoint === 'count_tokens'
      ? null
      : findTokenLimitViolation(endpoint, body, maxTokens);
  if (tokenLimitViolation) return tokenLimitViolation;
  return endpoint === 'messages' || endpoint === 'count_tokens'
    ? findUnsupportedMessagesField(body)
    : findUnsupportedChatField(body);
}

function findTokenLimitViolation(
  endpoint: Exclude<LlmPassthroughEndpoint, 'count_tokens'>,
  body: Record<string, unknown>,
  maxTokens: number | undefined,
): UnsupportedLlmRequestField | null {
  if (maxTokens === undefined) return null;
  let hasDeclaredLimit = false;
  for (const field of OUTPUT_TOKEN_FIELDS) {
    const declared = body[field];
    if (typeof declared === 'number') {
      hasDeclaredLimit = true;
      const choices =
        endpoint === 'chat_completions' && typeof body.n === 'number'
          ? body.n
          : 1;
      const requested = declared * choices;
      if (requested <= maxTokens) continue;
      return {
        code: 'MAX_TOKENS_EXCEEDED',
        field,
        limit: maxTokens,
        requested,
        message:
          choices === 1
            ? `Request field "${field}" value ${requested} exceeds this API key's output-token limit of ${maxTokens}.`
            : `Request field "${field}" value ${declared} with n=${choices} requests ${requested} output tokens, exceeding this API key's output-token limit of ${maxTokens}.`,
      };
    }
  }
  if (hasDeclaredLimit) return null;
  return {
    code: 'MAX_TOKENS_EXCEEDED',
    field: 'max_tokens',
    limit: maxTokens,
    message: `This API key requires an explicit "max_tokens" (or "max_completion_tokens") at or below its output-token limit of ${maxTokens}.`,
  };
}

function findUnsupportedMessagesField(
  body: Record<string, unknown>,
): UnsupportedLlmRequestField | null {
  for (const field of MESSAGES_PROVIDER_EXECUTION_FIELDS) {
    if (hasOwn(body, field)) return unsupportedField(field);
  }
  if (Array.isArray(body.tools)) {
    for (const [index, tool] of body.tools.entries()) {
      if (isRecord(tool) && hasOwn(tool, 'type')) {
        return unsupportedToolType(`tools[${index}].type`, tool.type);
      }
    }
  }
  if (Array.isArray(body.betas)) {
    for (const [index, beta] of body.betas.entries()) {
      if (typeof beta === 'string' && SERVER_EXECUTION_BETA.test(beta)) {
        const field = `betas[${index}]`;
        return {
          field,
          value: beta,
          message: `Provider-side execution beta "${beta}" at "${field}" is not supported by the direct LLM API.`,
        };
      }
    }
  }
  return null;
}

function findUnsupportedChatField(
  body: Record<string, unknown>,
): UnsupportedLlmRequestField | null {
  for (const field of CHAT_HOSTED_TOOL_FIELDS) {
    if (hasOwn(body, field)) return unsupportedField(field);
  }
  for (const field of CHAT_FILE_REFERENCE_FIELDS) {
    if (hasOwn(body, field)) return unsupportedField(field);
  }
  if (Array.isArray(body.tools)) {
    for (const [index, tool] of body.tools.entries()) {
      const toolType = isRecord(tool) ? tool.type : undefined;
      if (toolType !== 'function') {
        return unsupportedToolType(`tools[${index}].type`, toolType);
      }
    }
  }
  if (!Array.isArray(body.messages)) return null;
  for (const [messageIndex, message] of body.messages.entries()) {
    if (!isRecord(message)) continue;
    for (const field of CHAT_FILE_REFERENCE_FIELDS) {
      if (hasOwn(message, field)) {
        return unsupportedField(`messages[${messageIndex}].${field}`);
      }
    }
    if (!Array.isArray(message.content)) continue;
    for (const [partIndex, part] of message.content.entries()) {
      if (!isRecord(part)) continue;
      const partPath = `messages[${messageIndex}].content[${partIndex}]`;
      if (
        typeof part.type === 'string' &&
        CHAT_FILE_CONTENT_TYPES.has(part.type)
      ) {
        return unsupportedToolType(`${partPath}.type`, part.type);
      }
      for (const field of CHAT_FILE_REFERENCE_FIELDS) {
        if (hasOwn(part, field)) {
          return unsupportedField(`${partPath}.${field}`);
        }
      }
    }
  }
  return null;
}

function unsupportedField(field: string): UnsupportedLlmRequestField {
  return {
    field,
    message: `Provider-side execution field "${field}" is not supported by the direct LLM API.`,
  };
}

function unsupportedToolType(
  field: string,
  type: unknown,
): UnsupportedLlmRequestField {
  const toolType = typeof type === 'string' ? type : '<missing>';
  return {
    field,
    toolType,
    message: `Provider-side tool type "${toolType}" at "${field}" is not supported by the direct LLM API.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
