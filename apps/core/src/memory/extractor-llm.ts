import {
  MODEL_EXTRACTOR,
  MEMORY_EXTRACTOR_MAX_FACTS,
  MEMORY_EXTRACTOR_MIN_CONFIDENCE,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import type {
  ExtractedMemoryFact,
  ExtractableMemoryKind,
  MemoryExtractionInput,
  MemoryExtractionProvider,
} from './memory-extractor.js';
import {
  MEMORY_EXTRACTION_FEW_SHOTS,
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
} from './prompts/extract.js';
import { hasClaudeAuthConfigured, runClaudeQuery } from './claude-query.js';

interface LlmFact {
  kind?: unknown;
  scope?: unknown;
  key?: unknown;
  value?: unknown;
  why?: unknown;
  confidence?: unknown;
  load_bearing?: unknown;
  supersedes?: unknown;
}

const ALLOWED_KINDS = new Set<ExtractableMemoryKind>([
  'preference',
  'decision',
  'fact',
  'correction',
  'constraint',
]);

const ALLOWED_SCOPES = new Set(['user', 'group', 'global']);
const MAX_MEMORY_VALUE_CHARS = 220;

function trimString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) return null;
  return trimmed;
}

function normalizeConfidence(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) return null;
  const clamped = Math.max(0, Math.min(1, parsed));
  return clamped;
}

function parseSupersedes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .map((entry) => trimString(entry, 128))
    .filter((entry): entry is string => Boolean(entry));
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

function normalizeForMatch(input: string): string {
  return input.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function parseFacts(
  raw: unknown,
  options: {
    minConfidence: number;
    maxFacts: number;
    sourceText: string;
    retrievedKeys: Set<string>;
    userId?: string;
  },
): ExtractedMemoryFact[] {
  if (!Array.isArray(raw)) return [];
  const normalizedSource = normalizeForMatch(options.sourceText);
  const out: ExtractedMemoryFact[] = [];
  for (const row of raw as LlmFact[]) {
    const kind = trimString(row.kind, 32);
    const scope = trimString(row.scope, 32);
    if (!kind || !ALLOWED_KINDS.has(kind as ExtractableMemoryKind)) continue;
    if (!scope || !ALLOWED_SCOPES.has(scope)) continue;
    const value = trimString(row.value, MAX_MEMORY_VALUE_CHARS);
    if (!value) continue;
    if (
      /\b(today|tomorrow|right now|for now|temporary|temp|quick fix|debugging this run|in this turn|next step|later today)\b/i.test(
        value,
      )
    ) {
      continue;
    }
    const confidence = normalizeConfidence(row.confidence);
    if (confidence === null || confidence < options.minConfidence) continue;
    const key = trimString(row.key, 128) || makeFallbackKey(kind, value);
    const why = trimString(row.why, 280) || undefined;
    if (why) {
      const grounded = normalizeForMatch(why);
      if (!grounded || !normalizedSource.includes(grounded)) {
        continue;
      }
    }
    const supersedes = parseSupersedes(row.supersedes);
    if (options.retrievedKeys.has(key.toLowerCase()) && !supersedes?.length) {
      continue;
    }
    const parsed: ExtractedMemoryFact = {
      scope: scope as ExtractedMemoryFact['scope'],
      kind: kind as ExtractableMemoryKind,
      key,
      value,
      confidence,
      ...(scope === 'user' && options.userId
        ? { user_id: options.userId }
        : {}),
      ...(why ? { why } : {}),
      ...(typeof row.load_bearing === 'boolean'
        ? { load_bearing: row.load_bearing }
        : {}),
      ...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
    };
    out.push(parsed);
    if (out.length >= options.maxFacts) break;
  }
  return dedupeFacts(out);
}

function dedupeFacts(facts: ExtractedMemoryFact[]): ExtractedMemoryFact[] {
  const seen = new Set<string>();
  const out: ExtractedMemoryFact[] = [];
  for (const fact of facts) {
    const key = `${fact.key}|${fact.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

function parseFirstJson(text: string): unknown {
  const startBracket = text.indexOf('[');
  const endBracket = text.lastIndexOf(']');
  if (startBracket >= 0 && endBracket > startBracket) {
    try {
      return JSON.parse(text.slice(startBracket, endBracket + 1));
    } catch {
      // fall through
    }
  }
  const startObject = text.indexOf('{');
  const endObject = text.lastIndexOf('}');
  if (startObject >= 0 && endObject > startObject) {
    try {
      return JSON.parse(text.slice(startObject, endObject + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function makeFallbackKey(kind: string, value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return `${kind}:${slug || 'memory'}`;
}

function buildPrompt(input: MemoryExtractionInput): string {
  const examples = MEMORY_EXTRACTION_FEW_SHOTS.map((shot, index) => {
    return [
      `Example ${index + 1} input:`,
      shot.input,
      `Example ${index + 1} output:`,
      JSON.stringify(shot.output, null, 2),
    ].join('\n');
  }).join('\n\n');

  const payload = {
    last_3_turns: [
      { role: 'user', text: input.prompt },
      { role: 'assistant', text: input.result },
    ],
    retrieved_items: (input.retrievedItems || []).slice(0, 10),
  };

  return [
    MEMORY_EXTRACTION_SYSTEM_PROMPT,
    '',
    examples,
    '',
    'Now extract from this input JSON and return strict JSON array only:',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

export class LlmMemoryExtractionProvider implements MemoryExtractionProvider {
  readonly providerName = 'llm-haiku';

  async extractFacts(
    input: MemoryExtractionInput,
  ): Promise<ExtractedMemoryFact[]> {
    const combined = `${input.prompt}\n${input.result}`.trim();
    if (!combined) {
      return [];
    }
    if (!hasClaudeAuthConfigured()) {
      return [];
    }

    try {
      const text = await runClaudeQuery({
        model: MODEL_EXTRACTOR,
        prompt: buildPrompt(input),
      });
      if (!text) return [];
      const parsed = parseFirstJson(text);
      return parseFacts(parsed, {
        minConfidence: MEMORY_EXTRACTOR_MIN_CONFIDENCE,
        maxFacts: MEMORY_EXTRACTOR_MAX_FACTS,
        sourceText: combined,
        userId: input.userId,
        retrievedKeys: new Set(
          (input.retrievedItems || [])
            .map((item) => item.key.toLowerCase().trim())
            .filter(Boolean),
        ),
      });
    } catch (err) {
      logger.warn(
        { err, model: MODEL_EXTRACTOR },
        'LLM extraction failed; skipping this turn',
      );
      return [];
    }
  }
}

export function createLlmMemoryExtractionProvider(
  _fallback?: MemoryExtractionProvider,
): MemoryExtractionProvider {
  return new LlmMemoryExtractionProvider();
}
