export const MAX_MCP_TOOL_RESULT_CHARS = 100_000;
const MAX_MCP_TOOL_RESULT_DEPTH = 12;
const MAX_MCP_TOOL_RESULT_COLLECTION_ITEMS = 1_000;
const TRUNCATED_MCP_TOOL_RESULT_MARKER = '[truncated MCP tool result]';

export function boundMcpToolResultForReturn(result: unknown): unknown {
  const serialized = serializeMcpToolResult(result, MAX_MCP_TOOL_RESULT_CHARS);
  if (!serialized.truncated) return result;
  return {
    type: 'mcp_tool_result_truncated',
    ...(isMcpToolErrorResult(result) ? { isError: true } : {}),
    truncated: true,
    maxChars: MAX_MCP_TOOL_RESULT_CHARS,
    preview: serialized.text,
  };
}

export function serializeMcpToolResult(
  result: unknown,
  maxChars = MAX_MCP_TOOL_RESULT_CHARS,
): { text: string; truncated: boolean } {
  const normalizedMaxChars = Math.max(0, Math.trunc(maxChars));
  if (typeof result === 'string') {
    return boundMcpToolResultText(result, normalizedMaxChars);
  }
  const bounded = boundMcpToolJsonValue(result ?? null, {
    depth: 0,
    remainingChars: normalizedMaxChars,
    seen: new WeakSet<object>(),
  });
  const text = stringifyMcpToolResult(bounded.value);
  if (!bounded.truncated && text.length <= normalizedMaxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, normalizedMaxChars)}\n${TRUNCATED_MCP_TOOL_RESULT_MARKER}`,
    truncated: true,
  };
}

function stringifyMcpToolResult(result: unknown): string {
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return '"[Unserializable MCP tool result]"';
  }
}

function isMcpToolErrorResult(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { isError?: unknown }).isError === true
  );
}

function boundMcpToolResultText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n${TRUNCATED_MCP_TOOL_RESULT_MARKER}`,
    truncated: true,
  };
}

type BoundedJsonState = {
  depth: number;
  remainingChars: number;
  seen: WeakSet<object>;
};

type BoundedJsonValue = {
  value: unknown;
  truncated: boolean;
};

function boundMcpToolJsonValue(
  value: unknown,
  state: BoundedJsonState,
): BoundedJsonValue {
  if (state.remainingChars <= 0) {
    return { value: TRUNCATED_MCP_TOOL_RESULT_MARKER, truncated: true };
  }
  if (value === null || typeof value === 'boolean') {
    spendMcpToolResultBudget(state, String(value).length);
    return { value, truncated: false };
  }
  if (typeof value === 'number') {
    spendMcpToolResultBudget(state, String(value).length);
    return { value, truncated: false };
  }
  if (typeof value === 'string') {
    return boundMcpToolJsonString(value, state);
  }
  if (typeof value === 'bigint') {
    const bounded = boundMcpToolJsonString(value.toString(), state);
    return { value: bounded.value, truncated: bounded.truncated };
  }
  if (typeof value === 'undefined') {
    spendMcpToolResultBudget(state, 4);
    return { value: null, truncated: false };
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    const bounded = boundMcpToolJsonString(
      '[unsupported MCP result value]',
      state,
    );
    return { value: bounded.value, truncated: true };
  }
  if (state.depth >= MAX_MCP_TOOL_RESULT_DEPTH) {
    return { value: TRUNCATED_MCP_TOOL_RESULT_MARKER, truncated: true };
  }

  const objectValue = value as object;
  if (state.seen.has(objectValue)) {
    return { value: '[circular MCP tool result]', truncated: true };
  }
  state.seen.add(objectValue);
  try {
    return Array.isArray(value)
      ? boundMcpToolJsonArray(value, state)
      : boundMcpToolJsonObject(value as Record<string, unknown>, state);
  } finally {
    state.seen.delete(objectValue);
  }
}

function boundMcpToolJsonArray(
  value: unknown[],
  state: BoundedJsonState,
): BoundedJsonValue {
  const output: unknown[] = [];
  let truncated = false;
  const childState = {
    ...state,
    depth: state.depth + 1,
  };
  const maxItems = Math.min(value.length, MAX_MCP_TOOL_RESULT_COLLECTION_ITEMS);
  for (let index = 0; index < maxItems; index += 1) {
    if (childState.remainingChars <= 0) {
      truncated = true;
      break;
    }
    const child = boundMcpToolJsonValue(value[index], childState);
    output.push(child.value);
    truncated ||= child.truncated;
  }
  if (value.length > maxItems || truncated) {
    output.push(TRUNCATED_MCP_TOOL_RESULT_MARKER);
    truncated = true;
  }
  state.remainingChars = childState.remainingChars;
  return { value: output, truncated };
}

function boundMcpToolJsonObject(
  value: Record<string, unknown>,
  state: BoundedJsonState,
): BoundedJsonValue {
  const output: Record<string, unknown> = {};
  let truncated = false;
  let itemCount = 0;
  const childState = {
    ...state,
    depth: state.depth + 1,
  };
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (
      itemCount >= MAX_MCP_TOOL_RESULT_COLLECTION_ITEMS ||
      childState.remainingChars <= 0
    ) {
      truncated = true;
      break;
    }
    const keyBudget = boundMcpToolJsonString(key, childState);
    const outputKey = String(keyBudget.value);
    truncated ||= keyBudget.truncated;
    let fieldValue: unknown;
    try {
      fieldValue = value[key];
    } catch {
      output[outputKey] = '[unreadable MCP tool result field]';
      truncated = true;
      itemCount += 1;
      continue;
    }
    const child = boundMcpToolJsonValue(fieldValue, childState);
    output[outputKey] = child.value;
    truncated ||= child.truncated;
    itemCount += 1;
  }
  if (truncated) {
    output[TRUNCATED_MCP_TOOL_RESULT_MARKER] = true;
  }
  state.remainingChars = childState.remainingChars;
  return { value: output, truncated };
}

function boundMcpToolJsonString(
  value: string,
  state: BoundedJsonState,
): BoundedJsonValue {
  if (value.length <= state.remainingChars) {
    spendMcpToolResultBudget(state, value.length);
    return { value, truncated: false };
  }
  const bounded = value.slice(0, Math.max(0, state.remainingChars));
  state.remainingChars = 0;
  return { value: bounded, truncated: true };
}

function spendMcpToolResultBudget(
  state: BoundedJsonState,
  chars: number,
): void {
  state.remainingChars = Math.max(0, state.remainingChars - chars);
}
