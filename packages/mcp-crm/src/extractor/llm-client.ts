import { query } from '@anthropic-ai/claude-agent-sdk';
import type { BoondiCrmEnv } from '../env.js';

export interface ExtractorLlm {
  // Returns the model's raw text (expected to be JSON).
  complete(input: {
    system: string;
    messages: Array<{ role: 'user'; content: string }>;
  }): Promise<string>;
}

// Per-call hard ceiling. Extraction is a background job (latency-tolerant), but a
// hung CLI subprocess must not wedge the watcher forever.
const QUERY_TIMEOUT_MS = 120_000;

// Credential keys the bootstrap (gantry-credentials.ts) projects into this
// process's env at startup. We hand exactly these to the spawned CLI — NOT the
// whole ambient env — so it authenticates the same way Gantry core does and so
// stray CLAUDE_CODE_* markers (present only when run from inside Claude Code,
// e.g. a probe) never make the child think it is nested. No proxy/CA: the
// Credential Center hands a real OAuth token that reaches Anthropic directly
// (core's agent runs on it with no proxy).
// Token vs API key are mutually exclusive by construction: the bootstrap
// early-returns when ANTHROPIC_API_KEY is set (and never projects the OAuth
// token), so at most one auth credential is ever present here. ANTHROPIC_API_KEY
// is kept in the list only so the deliberate raw-key path still reaches the child.
const SDK_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'PATH',
  'HOME',
] as const;

function sdkEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SDK_ENV_KEYS) {
    const value = process.env[key];
    if (value) out[key] = value;
  }
  return out;
}

function hasModelCredential(env: BoondiCrmEnv): boolean {
  return Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
      process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
      env.anthropicApiKey,
  );
}

function readAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const row = message as { type?: unknown; message?: { content?: unknown } };
  if (row.type !== 'assistant') return '';
  const content = row.message?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    const typed = block as { type?: unknown; text?: unknown };
    if (typed && typed.type === 'text' && typeof typed.text === 'string') {
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

// Drive the extraction model through the Claude Agent SDK's query() — the SAME
// path Gantry core uses for the live agent and memory extraction. This matters:
// a subscription OAuth token is rate-limited to
// 429 on the raw Messages API, but works through the first-party CLI the Agent SDK
// spawns. The Credential Center bootstrap (gantry-credentials.ts) must have projected the
// OAuth token into this process's env first; otherwise this returns null and the
// extractor disables.
export function createAnthropicExtractorLlm(env: BoondiCrmEnv): ExtractorLlm | null {
  if (!hasModelCredential(env)) return null;
  return {
    async complete({ system, messages }) {
      // The SDK takes one prompt string. Flatten system + user turns the way core's
      // memory query does (a leading "System:" block), so the extraction prompt is
      // ours and not Claude Code's default system prompt.
      const prompt = `System:\n${system}\n\n${messages
        .map((m) => m.content)
        .join('\n\n')}`;
      const abortController = new AbortController();
      const timer = setTimeout(
        () => abortController.abort(new Error('extractor query timed out')),
        QUERY_TIMEOUT_MS,
      );
      let assistantText = '';
      let resultText = '';
      try {
        const stream = query({
          prompt,
          options: {
            abortController,
            model: env.crmLeadQueryExtractionWatcher.model,
            maxTurns: 1,
            // Pure text extraction — no tools, and don't load any ambient
            // ~/.claude settings/skills that would pollute the prompt.
            tools: [] as [],
            settingSources: [],
            env: sdkEnv(),
          },
        }) as AsyncIterable<unknown>;
        for await (const message of stream) {
          assistantText += readAssistantText(message);
          if (!resultText) resultText = readResultText(message);
        }
      } finally {
        clearTimeout(timer);
      }
      return (assistantText || resultText).trim();
    },
  };
}
