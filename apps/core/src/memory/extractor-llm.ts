import {
  getMemoryModelRuntimeConfig,
  MEMORY_EXTRACTOR_MAX_FACTS,
  MEMORY_EXTRACTOR_MIN_CONFIDENCE,
} from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { sleep } from '../shared/time/datetime.js';
import {
  MEMORY_EXTRACTION_FEW_SHOTS,
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
} from './prompts/extract.js';
import { getMemoryLlmClient, type MemoryLlmUsage } from './memory-llm-port.js';
import type {
  ArcExtractionInput,
  ExtractedMemoryFact,
  ExtractableMemoryKind,
  MemoryExtractionResult,
  MemoryExtractionProvider,
} from './extractor-types.js';
import { sanitizeOutboundLlmText } from '../shared/sensitive-material.js';
import {
  parseItemSource,
  type CanonicalMemoryItemRow,
} from './app-memory-canonical-codec.js';
import { extractMemoryValue } from './app-memory-dreaming-candidate-guardrails.js';
import { extractionResult } from './extraction-result.js';
import { isTransientExtractorError } from './extractor-llm-errors.js';
import type {
  MemoryKind,
  MemoryLifecycleProposal,
  NormalizedMemorySubject,
} from './memory-types.js';

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

type ArcTurn = ArcExtractionInput['turns'][number];

const ALLOWED_KINDS = new Set<ExtractableMemoryKind>([
  'preference',
  'decision',
  'fact',
  'correction',
  'constraint',
]);

const ALLOWED_SCOPES = new Set(['user', 'group', 'global']);
const MAX_MEMORY_VALUE_CHARS = 220;
const PROMPT_RETRIEVED_ITEM_LIMIT = 10;
const PROMPT_RETRIEVED_KEY_CHAR_BUDGET = 180;
const PROMPT_RETRIEVED_VALUE_CHAR_BUDGET = 420;
const MIN_GROUNDED_WHY_CHARS = 8;
const EXTRACT_RETRY_DELAY_MS = 2000;
const RETRIEVED_TOOL_RESULT_TEXT_PATTERN = /\btool[_ -]?result\b/i;

function normalizeGroundingText(value: string): string {
  return value.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeGroundingLoose(value: string): string {
  return normalizeGroundingText(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripQuotedBoundaries(value: string): string {
  return value.replace(/^["'`]+|["'`]+$/g, '').trim();
}

function buildGroundingCorpus(turns: ArcTurn[]): {
  userStrict: string;
  userLoose: string;
  allStrict: string;
  allLoose: string;
} {
  const userText = turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.text)
    .join('\n');
  const allText = turns.map((turn) => turn.text).join('\n');
  return {
    userStrict: normalizeGroundingText(userText),
    userLoose: normalizeGroundingLoose(userText),
    allStrict: normalizeGroundingText(allText),
    allLoose: normalizeGroundingLoose(allText),
  };
}

function isGroundedWhy(
  why: string,
  corpus: ReturnType<typeof buildGroundingCorpus>,
): boolean {
  const strictNeedle = normalizeGroundingText(stripQuotedBoundaries(why));
  if (strictNeedle.length < MIN_GROUNDED_WHY_CHARS) return false;
  if (corpus.userStrict.includes(strictNeedle)) return true;
  if (corpus.allStrict.includes(strictNeedle)) return true;

  const looseNeedle = normalizeGroundingLoose(strictNeedle);
  if (looseNeedle.length < MIN_GROUNDED_WHY_CHARS) return false;
  return (
    corpus.userLoose.includes(looseNeedle) ||
    corpus.allLoose.includes(looseNeedle)
  );
}

const MEMORY_PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|rules?)\b/i,
  /\b(?:override|bypass)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|instructions?)\b/i,
  /\b(?:reveal|expose|leak|dump|print)\s+(?:the\s+)?(?:system|developer|hidden)\s+(?:prompt|instructions?)\b/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\b(?:jailbreak|prompt\s+injection)\b/i,
  /\brespond\s+only\s+with\b/i,
  /\bdo\s+not\s+follow\s+(?:the\s+)?(?:rules?|instructions?)\b/i,
];

function looksLikePromptInjection(text: string): boolean {
  return MEMORY_PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

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

function parseFacts(
  raw: unknown,
  options: {
    minConfidence: number;
    maxFacts: number;
    retrievedKeys: Set<string>;
    userId?: string;
    turns: ArcTurn[];
  },
): ExtractedMemoryFact[] {
  if (!Array.isArray(raw)) return [];
  const groundingCorpus = buildGroundingCorpus(options.turns);
  const out: ExtractedMemoryFact[] = [];
  for (const row of raw as LlmFact[]) {
    const kind = trimString(row.kind, 32);
    const scope = trimString(row.scope, 32);
    if (!kind || !ALLOWED_KINDS.has(kind as ExtractableMemoryKind)) continue;
    if (!scope || !ALLOWED_SCOPES.has(scope)) continue;
    const resolvedScope = scope === 'user' && !options.userId ? 'group' : scope;
    const value = trimString(row.value, MAX_MEMORY_VALUE_CHARS);
    if (!value) continue;
    if (looksLikePromptInjection(value)) continue;
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
    const why = trimString(row.why, 280);
    if (!why) continue;
    if (looksLikePromptInjection(why)) continue;
    if (!isGroundedWhy(why, groundingCorpus)) continue;
    const supersedes = parseSupersedes(row.supersedes);
    if (options.retrievedKeys.has(key.toLowerCase()) && !supersedes?.length) {
      continue;
    }
    const parsed: ExtractedMemoryFact = {
      scope: resolvedScope as ExtractedMemoryFact['scope'],
      kind: kind as ExtractableMemoryKind,
      key,
      value,
      confidence,
      ...(resolvedScope === 'user' && options.userId
        ? { user_id: options.userId }
        : {}),
      why,
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

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function summarizeRetrievedItemField(
  value: string,
  maxChars: number,
  label: string,
): string | null {
  const sanitized = sanitizeOutboundLlmText(value);
  const text = sanitized.text.trim();
  if (!text) return null;
  if (RETRIEVED_TOOL_RESULT_TEXT_PATTERN.test(text)) {
    return `[${label} chars=${text.length} omitted=tool_result_like]`;
  }
  if (text.length <= maxChars) return text;
  const excerptBudget = Math.max(80, maxChars - 64);
  const excerpt = truncate(text, excerptBudget);
  return `[${label} chars=${text.length} excerpt=${JSON.stringify(excerpt)}]`;
}

function buildPromptParts(input: ArcExtractionInput): {
  systemPrompt: string;
  staticUserBlock: string;
  dynamicUserBlock: string;
  plainPrompt: string;
} {
  const examples = MEMORY_EXTRACTION_FEW_SHOTS.map((shot, index) => {
    return [
      `Example ${index + 1} input:`,
      JSON.stringify(shot.input, null, 2),
      `Example ${index + 1} output:`,
      JSON.stringify(shot.output, null, 2),
    ].join('\n');
  }).join('\n\n');

  const payload = {
    session_arc: input.turns,
    trigger: input.trigger,
    retrieved_items: (input.retrievedItems || []).slice(
      0,
      PROMPT_RETRIEVED_ITEM_LIMIT,
    ),
  };

  const staticUserBlock = [
    'Reference examples (high precision, strict filtering):',
    examples,
  ].join('\n\n');
  const dynamicUserBlock = [
    'Now extract from this session arc and return strict JSON array only:',
    JSON.stringify(payload, null, 2),
  ].join('\n');
  return {
    systemPrompt: MEMORY_EXTRACTION_SYSTEM_PROMPT,
    staticUserBlock,
    dynamicUserBlock,
    plainPrompt: [
      MEMORY_EXTRACTION_SYSTEM_PROMPT,
      '',
      staticUserBlock,
      '',
      dynamicUserBlock,
    ].join('\n'),
  };
}

export class LlmMemoryExtractionProvider implements MemoryExtractionProvider {
  readonly providerName = 'llm-haiku';

  async extractFacts(
    input: ArcExtractionInput,
  ): Promise<ExtractedMemoryFact[]> {
    return (await this.extractFactsWithOutcome(input)).facts;
  }

  async extractFactsWithOutcome(
    input: ArcExtractionInput,
  ): Promise<MemoryExtractionResult> {
    const modelExtractor = getMemoryModelRuntimeConfig().extractor;
    const turns = Array.isArray(input.turns) ? input.turns : [];
    if (!turns.length) {
      return extractionResult([]);
    }
    const memoryLlm = getMemoryLlmClient();
    if (!memoryLlm.isConfigured()) {
      return extractionResult([], 'auth_unavailable', 'auth_unavailable');
    }

    const sanitizedTurns = turns.map((turn) => {
      const sanitized = sanitizeOutboundLlmText(turn.text);
      return {
        role: turn.role,
        text: sanitized.text,
        blocked: sanitized.blocked,
        reason: sanitized.reason,
      };
    });
    const blockedTurn = sanitizedTurns.find((turn) => turn.blocked);
    if (blockedTurn) {
      logger.warn(
        {
          model: modelExtractor,
          trigger: input.trigger,
          reason: blockedTurn.reason || 'potential_sensitive_material',
        },
        'LLM extraction blocked due to potential sensitive transcript material',
      );
      return extractionResult([], 'sensitive_blocked', 'sensitive_blocked');
    }

    const sanitizedRetrievedItems = (input.retrievedItems || [])
      .slice(0, PROMPT_RETRIEVED_ITEM_LIMIT)
      .flatMap((item) => {
        const key = sanitizeOutboundLlmText(item.key);
        const value = sanitizeOutboundLlmText(item.value);
        if (key.blocked || value.blocked) {
          logger.warn(
            {
              model: modelExtractor,
              trigger: input.trigger,
              memory_id: item.id,
              key_reason: key.reason || null,
              value_reason: value.reason || null,
            },
            'Dropped retrieved memory item from outbound extraction prompt due to potential sensitive material',
          );
          return [];
        }
        const boundedKey = summarizeRetrievedItemField(
          key.text,
          PROMPT_RETRIEVED_KEY_CHAR_BUDGET,
          'memory_key',
        );
        const boundedValue = summarizeRetrievedItemField(
          value.text,
          PROMPT_RETRIEVED_VALUE_CHAR_BUDGET,
          'memory_value',
        );
        if (!boundedKey || !boundedValue) return [];
        return [
          {
            id: item.id,
            key: boundedKey,
            value: boundedValue,
          },
        ];
      });

    const promptParts = buildPromptParts({
      ...input,
      turns: sanitizedTurns.map((turn) => ({
        role: turn.role,
        text: turn.text,
      })),
      retrievedItems: sanitizedRetrievedItems,
    });
    let usage: MemoryLlmUsage | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const text = await memoryLlm.query({
          model: modelExtractor,
          prompt: promptParts.plainPrompt,
          systemPrompt: promptParts.systemPrompt,
          userBlocks: [
            { text: promptParts.staticUserBlock, cacheStatic: true },
            { text: promptParts.dynamicUserBlock },
          ],
          onUsage: (nextUsage) => {
            usage = nextUsage;
            input.onUsage?.({
              model: modelExtractor,
              ...nextUsage,
            });
          },
        });
        if (usage) {
          logger.info(
            {
              model: modelExtractor,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens || 0,
              cache_creation_input_tokens:
                usage.cache_creation_input_tokens || 0,
            },
            'LLM extraction token usage',
          );
        }
        if (!text.trim()) {
          logger.warn(
            { model: modelExtractor, trigger: input.trigger },
            'LLM extraction returned malformed output; skipping this boundary extraction',
          );
          return extractionResult([], 'extractor_failed', 'extractor_failed');
        }
        const parsed = parseFirstJson(text);
        if (!Array.isArray(parsed)) {
          logger.warn(
            { model: modelExtractor, trigger: input.trigger },
            'LLM extraction returned malformed output; skipping this boundary extraction',
          );
          return extractionResult([], 'extractor_failed', 'extractor_failed');
        }
        return extractionResult(
          parseFacts(parsed, {
            minConfidence: MEMORY_EXTRACTOR_MIN_CONFIDENCE,
            maxFacts: MEMORY_EXTRACTOR_MAX_FACTS,
            userId: input.userId,
            turns,
            retrievedKeys: new Set(
              (input.retrievedItems || [])
                .map((item) => item.key.toLowerCase().trim())
                .filter(Boolean),
            ),
          }),
        );
      } catch (err) {
        const transient = isTransientExtractorError(err);
        if (attempt === 0 && transient) {
          logger.warn(
            { err, model: modelExtractor, retryInMs: EXTRACT_RETRY_DELAY_MS },
            'Transient extractor failure; retrying once',
          );
          await sleep(EXTRACT_RETRY_DELAY_MS);
          continue;
        }
        logger.warn(
          { err, model: modelExtractor },
          'LLM extraction failed; skipping this boundary extraction',
        );
        return extractionResult([], 'extractor_failed', 'extractor_failed');
      }
    }
    return extractionResult([], 'extractor_failed', 'extractor_failed');
  }
}

export function createLlmMemoryExtractionProvider(): MemoryExtractionProvider {
  return new LlmMemoryExtractionProvider();
}

type ProposalEvidenceRow = {
  id: string;
  text: string;
  metadataJson: string;
};

type ProposalCandidateRow = {
  id: string;
  kind: string;
  key: string;
  value: string;
  reason: string | null;
  confidence: number;
  evidenceIdsJson: string;
  updatedAt: string;
};

const MEMORY_DREAMING_PROPOSAL_PROMPT = [
  'You review grounded memory evidence and staged candidates.',
  'Return strict JSON array: {"action":"stage_candidate|promote|update|retire|needs_review|skip","candidate_id?":"id","item_id?":"id","kind?":"preference|decision|fact|correction|constraint","key?":"key","value?":"value","reason":"short reason","confidence":0.0,"evidence_ids":["id"]}.',
  'Use only provided IDs and evidence; never copy raw transcripts; retire, contradiction, and rewrite-like corrections require needs_review; evidence_ids are required.',
].join('\n');

const MEMORY_CONSOLIDATION_PROPOSAL_PROMPT = [
  'You consolidate active memory items.',
  'Return strict JSON array: {"action":"keep|merge|rewrite|retire|needs_review|skip","item_ids":["id"],"target_item_id?":"id","key?":"key","value?":"value","reason":"short reason","confidence":0.0,"evidence_ids":["id"]}.',
  'Use only provided item IDs and evidence IDs; merge only obvious duplicates in the same subject scope; rewrite and retire require review; do not invent facts.',
].join('\n');

function parseJsonArrayLoose(value: string | null | undefined): unknown[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  const first = trimmed.indexOf('[');
  const last = trimmed.lastIndexOf(']');
  const candidate =
    first >= 0 && last >= first ? trimmed.slice(first, last + 1) : trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseProposalStringArray(value: string): string[] {
  return parseJsonArrayLoose(value).filter(
    (entry): entry is string => typeof entry === 'string',
  );
}

function normalizeLifecycleProposal(
  raw: unknown,
): MemoryLifecycleProposal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const action = typeof row.action === 'string' ? row.action : '';
  const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
  const confidence =
    typeof row.confidence === 'number' && Number.isFinite(row.confidence)
      ? row.confidence
      : -1;
  const evidenceIds = Array.isArray(row.evidence_ids)
    ? row.evidence_ids.filter(
        (entry): entry is string => typeof entry === 'string' && !!entry.trim(),
      )
    : [];
  if (!action || !reason || confidence < 0 || confidence > 1) return null;
  return {
    action: action as MemoryLifecycleProposal['action'],
    ...(typeof row.candidate_id === 'string'
      ? { candidateId: row.candidate_id }
      : {}),
    ...(typeof row.item_id === 'string' ? { itemId: row.item_id } : {}),
    ...(Array.isArray(row.item_ids)
      ? {
          itemIds: row.item_ids.filter(
            (entry): entry is string => typeof entry === 'string',
          ),
        }
      : {}),
    ...(typeof row.target_item_id === 'string'
      ? { targetItemId: row.target_item_id }
      : {}),
    ...(typeof row.kind === 'string' ? { kind: row.kind as MemoryKind } : {}),
    ...(typeof row.key === 'string' ? { key: row.key.trim() } : {}),
    ...(typeof row.value === 'string' ? { value: row.value.trim() } : {}),
    reason,
    confidence,
    evidenceIds,
  };
}

function safeProposalText(value: string, max = 600): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export async function proposeMemoryDreamingActions(input: {
  subject: NormalizedMemorySubject;
  evidence: ProposalEvidenceRow[];
  candidates: ProposalCandidateRow[];
  activeItems: CanonicalMemoryItemRow[];
}): Promise<MemoryLifecycleProposal[]> {
  const memoryLlm = getMemoryLlmClient();
  if (!memoryLlm.isConfigured()) return [];
  const model = getMemoryModelRuntimeConfig().dreaming;
  const payload = {
    subject: {
      app_id: input.subject.appId,
      agent_id: input.subject.agentId,
      subject_type: input.subject.subjectType,
      subject_id: input.subject.subjectId,
      thread_id: input.subject.threadId ?? null,
    },
    evidence: input.evidence.slice(0, 20).map((row) => ({
      id: row.id,
      text: safeProposalText(row.text),
      metadata: row.metadataJson,
    })),
    candidates: input.candidates.slice(0, 20).map((row) => ({
      id: row.id,
      kind: row.kind,
      key: row.key,
      value: safeProposalText(row.value),
      reason: row.reason,
      confidence: row.confidence,
      evidence_ids: parseProposalStringArray(row.evidenceIdsJson),
      updated_at: row.updatedAt,
    })),
    active_items: input.activeItems.slice(0, 50).map((row) => ({
      id: row.id,
      kind: row.kind,
      key: row.key,
      value: safeProposalText(extractMemoryValue(row)),
      confidence: row.confidence,
      updated_at: row.updatedAt,
    })),
  };
  try {
    const text = await memoryLlm.query({
      model,
      prompt: `${MEMORY_DREAMING_PROPOSAL_PROMPT}\n\n${JSON.stringify(payload, null, 2)}`,
      systemPrompt: MEMORY_DREAMING_PROPOSAL_PROMPT,
    });
    return parseJsonArrayLoose(text)
      .map(normalizeLifecycleProposal)
      .filter((entry): entry is MemoryLifecycleProposal => Boolean(entry));
  } catch (err) {
    logger.warn({ err, model }, 'LLM memory dreaming proposal failed');
    return [];
  }
}

export async function proposeMemoryConsolidationActions(input: {
  subject: NormalizedMemorySubject;
  activeItems: CanonicalMemoryItemRow[];
}): Promise<MemoryLifecycleProposal[]> {
  const memoryLlm = getMemoryLlmClient();
  if (!memoryLlm.isConfigured()) return [];
  const model = getMemoryModelRuntimeConfig().consolidation;
  const payload = {
    subject: {
      app_id: input.subject.appId,
      agent_id: input.subject.agentId,
      subject_type: input.subject.subjectType,
      subject_id: input.subject.subjectId,
      thread_id: input.subject.threadId ?? null,
    },
    active_items: input.activeItems.slice(0, 80).map((row) => ({
      id: row.id,
      kind: row.kind,
      key: row.key,
      value: safeProposalText(extractMemoryValue(row)),
      confidence: row.confidence,
      evidence_ids: parseItemSource(row).evidenceIds,
      updated_at: row.updatedAt,
    })),
  };
  try {
    const text = await memoryLlm.query({
      model,
      prompt: `${MEMORY_CONSOLIDATION_PROPOSAL_PROMPT}\n\n${JSON.stringify(payload, null, 2)}`,
      systemPrompt: MEMORY_CONSOLIDATION_PROPOSAL_PROMPT,
    });
    return parseJsonArrayLoose(text)
      .map(normalizeLifecycleProposal)
      .filter((entry): entry is MemoryLifecycleProposal => Boolean(entry));
  } catch (err) {
    logger.warn({ err, model }, 'LLM memory consolidation proposal failed');
    return [];
  }
}
