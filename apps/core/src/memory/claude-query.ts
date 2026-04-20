import Anthropic from '@anthropic-ai/sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  type ClaudeAuthState,
  type ClaudeAuthMode,
  resolveClaudeAuthState,
} from '../core/config.js';

export interface ClaudeQueryOpts {
  model: string;
  prompt: string;
  systemPrompt?: string;
  userBlocks?: Array<{
    text: string;
    cacheStatic?: boolean;
  }>;
  onUsage?: (usage: ClaudeUsage) => void;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeAuthAvailability {
  hasOauthToken: boolean;
  hasApiKey: boolean;
  mode: ClaudeAuthMode;
}

export function getClaudeAuthAvailability(): ClaudeAuthAvailability {
  const auth = resolveClaudeAuthState();
  return {
    hasOauthToken: auth.hasOauthToken,
    hasApiKey: auth.hasApiKey,
    mode: auth.mode,
  };
}

export function hasClaudeAuthConfigured(): boolean {
  return getClaudeAuthAvailability().mode !== 'none';
}

function readAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const row = message as {
    type?: unknown;
    message?: { content?: unknown };
  };
  if (row.type !== 'assistant') return '';
  const content = row.message?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      out += typed.text;
    }
  }
  return out;
}

function readResultText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const row = message as { type?: unknown; result?: unknown };
  if (row.type !== 'result') return '';
  return typeof row.result === 'string' ? row.result : '';
}

async function runWithOauth(
  opts: ClaudeQueryOpts,
  auth: ClaudeAuthState,
): Promise<string> {
  const oauthEnv: Record<string, string> = {
    ...(auth.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: auth.oauthToken } : {}),
    ...(auth.apiKey ? { ANTHROPIC_API_KEY: auth.apiKey } : {}),
  };
  const stream = query({
    prompt: opts.prompt,
    options: {
      model: opts.model,
      maxTurns: 1,
      ...(Object.keys(oauthEnv).length > 0 ? { env: oauthEnv } : {}),
    },
  }) as AsyncIterable<unknown>;

  let assistantText = '';
  let resultText = '';

  for await (const message of stream) {
    assistantText += readAssistantText(message);
    if (!resultText) {
      resultText = readResultText(message);
    }
  }

  return (assistantText || resultText).trim();
}

function readAnthropicResponseText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const row = response as {
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
  if (!Array.isArray(row.content)) return '';
  let text = '';
  for (const block of row.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text.trim();
}

function readAnthropicUsage(response: unknown): ClaudeUsage | null {
  if (!response || typeof response !== 'object') return null;
  const row = response as {
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
  const usage = row.usage;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.input_tokens);
  const outputTokens = Number(usage.output_tokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
    return null;
  }
  const cacheRead = Number(usage.cache_read_input_tokens);
  const cacheCreate = Number(usage.cache_creation_input_tokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(Number.isFinite(cacheRead)
      ? { cache_read_input_tokens: cacheRead }
      : {}),
    ...(Number.isFinite(cacheCreate)
      ? { cache_creation_input_tokens: cacheCreate }
      : {}),
  };
}

async function runWithApiKey(
  opts: ClaudeQueryOpts,
  auth: ClaudeAuthState,
): Promise<string> {
  if (!auth.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  const client = new Anthropic({ apiKey: auth.apiKey });
  const response =
    opts.systemPrompt || (opts.userBlocks && opts.userBlocks.length > 0)
      ? await client.messages.create({
          model: opts.model,
          max_tokens: 2048,
          ...(opts.systemPrompt
            ? {
                system: [
                  {
                    type: 'text',
                    text: opts.systemPrompt,
                    cache_control: { type: 'ephemeral' },
                  } as unknown as Record<string, unknown>,
                ],
              }
            : {}),
          messages: [
            {
              role: 'user',
              content:
                opts.userBlocks && opts.userBlocks.length > 0
                  ? opts.userBlocks.map((block) => ({
                      type: 'text',
                      text: block.text,
                      ...(block.cacheStatic
                        ? { cache_control: { type: 'ephemeral' } }
                        : {}),
                    }))
                  : [{ type: 'text', text: opts.prompt }],
            },
          ],
        } as unknown as Parameters<typeof client.messages.create>[0])
      : await client.messages.create({
          model: opts.model,
          max_tokens: 2048,
          messages: [
            {
              role: 'user',
              content: opts.prompt,
            },
          ],
        });
  const usage = readAnthropicUsage(response);
  if (usage && opts.onUsage) {
    opts.onUsage(usage);
  }
  return readAnthropicResponseText(response);
}

export async function runClaudeQuery(opts: ClaudeQueryOpts): Promise<string> {
  const auth = resolveClaudeAuthState();
  if (auth.mode === 'none') {
    throw new Error(
      'Claude auth is not configured (set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)',
    );
  }

  if (auth.mode === 'oauth') {
    try {
      return await runWithOauth(opts, auth);
    } catch (error) {
      if (auth.hasApiKey) {
        return runWithApiKey(opts, auth);
      }
      throw error;
    }
  }

  return runWithApiKey(opts, auth);
}
