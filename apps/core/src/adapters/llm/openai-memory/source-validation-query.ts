import type { MemoryLlmQueryOpts } from '../../../domain/ports/memory-llm-client.js';

/** Independent tool-free request for the configured OpenAI source operation. */
export async function queryOpenAiSourceValidation(input: {
  opts: MemoryLlmQueryOpts;
  baseUrl: string;
  token: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
}): Promise<string> {
  const { opts, baseUrl, token, messages } = input;
  const maxOutputTokens = opts.maxOutputTokens;
  if (
    !Number.isInteger(maxOutputTokens) ||
    !maxOutputTokens ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 4096
  )
    throw new Error('Source validation requires a bounded output budget');
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      input: messages,
      max_output_tokens: maxOutputTokens,
      tools: [],
      store: false,
      ...(opts.operationId?.startsWith('source-learning:')
        ? { text: { format: { type: 'json_object' } } }
        : {}),
    }),
    signal: opts.signal,
  });
  if (!response.ok)
    throw new Error(
      `Source validation Responses query failed (${response.status})`,
    );
  const parsed = (await response.json()) as {
    status?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
  const usage = parsed.usage;
  if (usage) {
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    opts.onUsage?.({
      input_tokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
      output_tokens: usage.output_tokens ?? 0,
      ...(cached ? { cache_read_input_tokens: cached } : {}),
    });
  }
  opts.signal?.throwIfAborted();
  if (parsed.status && parsed.status !== 'completed')
    throw new Error('Source validation Responses query was incomplete');
  return (parsed.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('')
    .trim();
}
