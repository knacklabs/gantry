function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function bindWebsiteRecipeHumanIdentity(
  toolInput: unknown,
  jobPrompt: string | null | undefined,
): Record<string, unknown> {
  const input = record(toolInput);
  const trusted = websiteRecipeInputFromJobPrompt(jobPrompt);
  const requestId =
    typeof trusted.requestId === 'string' ? trusted.requestId : '';
  const attemptId =
    typeof trusted.attemptId === 'string' ? trusted.attemptId : '';
  return requestId && attemptId ? { ...input, requestId, attemptId } : input;
}

export function bindWebsiteRecipeTerminalIdentity(
  result: string,
  jobPrompt: string | null | undefined,
): string {
  const trusted = websiteRecipeInputFromJobPrompt(jobPrompt);
  const requestId =
    typeof trusted.requestId === 'string' ? trusted.requestId : '';
  const attemptId =
    typeof trusted.attemptId === 'string' ? trusted.attemptId : '';
  if (!requestId || !attemptId) return result;
  try {
    const terminal = record(JSON.parse(result));
    if (terminal.version !== 2) return result;
    return JSON.stringify({ ...terminal, requestId, attemptId });
  } catch {
    return result;
  }
}

function websiteRecipeInputFromJobPrompt(
  prompt: string | null | undefined,
): Record<string, unknown> {
  if (!prompt) return {};
  const marker = '\nINPUT_JSON\n';
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex < 0) return {};
  const source = prompt.slice(markerIndex + marker.length);
  const start = source.indexOf('{');
  if (start < 0) return {};
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      try {
        return record(JSON.parse(source.slice(start, index + 1)));
      } catch {
        return {};
      }
    }
  }
  return {};
}
