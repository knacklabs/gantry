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

async function runWithApiKey(
  opts: ClaudeQueryOpts,
  auth: ClaudeAuthState,
): Promise<string> {
  if (!auth.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  const client = new Anthropic({ apiKey: auth.apiKey });
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: opts.prompt,
      },
    ],
  });
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
