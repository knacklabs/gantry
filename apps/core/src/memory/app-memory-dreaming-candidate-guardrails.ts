import type {
  MemoryKind,
  MemoryScope,
  NormalizedMemorySubject,
} from './memory-types.js';
import { classifySensitiveMemoryMaterial } from '../shared/sensitive-material.js';

const CANONICAL_DREAM_KINDS = new Set<MemoryKind>([
  'preference',
  'decision',
  'fact',
  'correction',
  'constraint',
]);
const CANONICAL_DREAM_SCOPES = new Set<MemoryScope>([
  'user',
  'group',
  'global',
]);
const MIN_DREAM_CANDIDATE_CONFIDENCE = 0.7;
const MAX_DREAM_VALUE_CHARS = 220;
const MAX_DREAM_WHY_CHARS = 280;
const MIN_DREAM_WHY_CHARS = 8;
const KEY_PATTERN = /^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9_-]{2,127}$/;
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|rules?)\b/i,
  /\b(?:override|bypass)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|instructions?)\b/i,
  /\b(?:reveal|expose|leak|dump|print)\s+(?:the\s+)?(?:system|developer|hidden)\s+(?:prompt|instructions?)\b/i,
  /\b(?:jailbreak|prompt\s+injection)\b/i,
  /\bdo\s+not\s+follow\s+(?:the\s+)?(?:rules?|instructions?)\b/i,
];
const TRANSIENT_MEMORY_PATTERN =
  /\b(today|tomorrow|right now|for now|temporary|temp|quick fix|debugging this run|in this turn|next step|later today)\b/i;

export interface StructuredDreamCandidate {
  kind: Extract<
    MemoryKind,
    'preference' | 'decision' | 'fact' | 'correction' | 'constraint'
  >;
  scope: MemoryScope;
  key: string;
  value: string;
  why: string;
  confidence: number;
  operation: 'promote' | 'retire';
  retireKey?: string;
}

type MemoryEvidenceRow = {
  metadataJson: string | null;
};

type MemoryCandidateRow = {
  kind: string;
  key: string;
  value: string;
  reason: string | null;
  confidence: number;
  evidenceIdsJson: string | null;
  metadataJson: string | null;
};

type MemoryItemRow = {
  valueJson: unknown;
};

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function trimString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
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
  return Math.max(0, Math.min(1, parsed));
}

function looksLikePromptInjection(text: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function isSafeMemoryText(text: string): boolean {
  return (
    !classifySensitiveMemoryMaterial(text) &&
    !looksLikePromptInjection(text) &&
    !TRANSIENT_MEMORY_PATTERN.test(text)
  );
}

function scopeMatchesSubject(
  scope: MemoryScope,
  subject: NormalizedMemorySubject,
): boolean {
  if (scope === 'user') return subject.subjectType === 'user';
  if (scope === 'global') return subject.subjectType === 'common';
  return subject.subjectType === 'group' || subject.subjectType === 'channel';
}

function isSafetyMarkedSafe(value: unknown): boolean {
  if (value === 'safe' || value === 'validated') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.status === 'safe' || record.status === 'validated') return true;
  if (record.classification === 'safe') return true;
  return record.blocked === false && record.reason === undefined;
}

function findStructuredCandidatePayload(
  metadata: Record<string, unknown>,
): Record<string, unknown> | null {
  for (const key of ['memoryCandidate', 'memory_candidate', 'candidate']) {
    const value = metadata[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return metadata.kind !== undefined ||
    metadata.scope !== undefined ||
    metadata.key !== undefined ||
    metadata.value !== undefined
    ? metadata
    : null;
}

export function parseStructuredEvidenceCandidate(
  evidence: MemoryEvidenceRow,
  subject: NormalizedMemorySubject,
): { candidate?: StructuredDreamCandidate; rejection?: string } {
  const metadata = parseJsonObject(evidence.metadataJson);
  const payload = findStructuredCandidatePayload(metadata);
  if (!payload)
    return { rejection: 'evidence has no structured candidate metadata' };

  const kind = trimString(payload.kind, 32);
  if (!kind || !CANONICAL_DREAM_KINDS.has(kind as MemoryKind)) {
    return { rejection: 'candidate kind is not canonical' };
  }

  const scope = trimString(payload.scope, 16);
  if (!scope || !CANONICAL_DREAM_SCOPES.has(scope as MemoryScope)) {
    return { rejection: 'candidate scope is not canonical' };
  }
  if (!scopeMatchesSubject(scope as MemoryScope, subject)) {
    return { rejection: 'candidate scope does not match dreaming subject' };
  }

  const key = trimString(payload.key, 128);
  if (!key || !KEY_PATTERN.test(key) || key.startsWith('evidence:')) {
    return { rejection: 'candidate key is not a stable canonical key' };
  }

  const value = trimString(payload.value, MAX_DREAM_VALUE_CHARS);
  if (!value) return { rejection: 'candidate value is missing or too long' };

  const why = trimString(payload.why, MAX_DREAM_WHY_CHARS);
  if (!why || why.length < MIN_DREAM_WHY_CHARS) {
    return { rejection: 'candidate grounding is missing or too weak' };
  }

  const confidence = normalizeConfidence(payload.confidence);
  if (confidence === null || confidence < MIN_DREAM_CANDIDATE_CONFIDENCE) {
    return { rejection: 'candidate confidence is below dreaming threshold' };
  }

  const safety = payload.safety ?? metadata.safety;
  if (!isSafetyMarkedSafe(safety)) {
    return { rejection: 'candidate safety has not been validated' };
  }

  const operationRaw =
    trimString(payload.operation ?? payload.action, 16)?.toLowerCase() ||
    'promote';
  if (operationRaw !== 'promote' && operationRaw !== 'retire') {
    return { rejection: 'candidate operation must be promote or retire' };
  }
  const retireKey =
    trimString(payload.retire_key ?? payload.retireKey, 128) || key;

  for (const [field, text] of [
    ['key', key],
    ['value', value],
    ['why', why],
  ] as const) {
    if (!isSafeMemoryText(text)) {
      return { rejection: `candidate ${field} failed safety guardrails` };
    }
  }

  return {
    candidate: {
      kind: kind as StructuredDreamCandidate['kind'],
      scope: scope as MemoryScope,
      key,
      value,
      why,
      confidence,
      operation: operationRaw,
      ...(operationRaw === 'retire' ? { retireKey } : {}),
    },
  };
}

export function parseStagedCandidateMetadata(candidate: MemoryCandidateRow): {
  operation: 'promote' | 'retire';
  retireKey?: string;
} {
  const metadata = parseJsonObject(candidate.metadataJson);
  const operation =
    trimString(metadata.operation ?? metadata.action, 16)?.toLowerCase() ||
    'promote';
  const retireKey =
    trimString(metadata.retire_key ?? metadata.retireKey, 128) || candidate.key;
  if (operation === 'retire') {
    return {
      operation: 'retire',
      retireKey,
    };
  }
  return { operation: 'promote' };
}

export function validatePromotableCandidate(candidate: MemoryCandidateRow): {
  ok: boolean;
  rationale: string;
  needsReview?: boolean;
} {
  if (!CANONICAL_DREAM_KINDS.has(candidate.kind as MemoryKind)) {
    return {
      ok: false,
      rationale: 'Staged candidate kind is not canonical for dreaming.',
    };
  }
  if (candidate.kind === 'preference') {
    return {
      ok: false,
      needsReview: true,
      rationale:
        'Staged preference candidates require review before becoming durable memory.',
    };
  }
  const metadata = parseJsonObject(candidate.metadataJson);
  if (
    metadata.requiresReview === true ||
    metadata.requires_review === true ||
    metadata.risky === true ||
    metadata.risk === 'high' ||
    metadata.riskLevel === 'high' ||
    metadata.risk_level === 'high'
  ) {
    return {
      ok: false,
      needsReview: true,
      rationale:
        'Staged candidate is marked risky and requires memory review before promotion.',
    };
  }
  if (
    metadata.contradiction === true ||
    metadata.contradicts === true ||
    metadata.operation === 'rewrite' ||
    metadata.action === 'rewrite'
  ) {
    return {
      ok: false,
      needsReview: true,
      rationale:
        'Staged candidate may contradict existing memory and requires review before promotion.',
    };
  }
  if (
    !KEY_PATTERN.test(candidate.key) ||
    candidate.key.startsWith('evidence:')
  ) {
    return {
      ok: false,
      rationale:
        'Staged candidate key is not canonical; raw evidence keys are not promotable.',
    };
  }
  if (candidate.confidence < MIN_DREAM_CANDIDATE_CONFIDENCE) {
    return {
      ok: false,
      rationale: 'Staged candidate confidence is below dreaming threshold.',
    };
  }
  if (
    !candidate.value.trim() ||
    candidate.value.length > MAX_DREAM_VALUE_CHARS ||
    !isSafeMemoryText(candidate.value)
  ) {
    return {
      ok: false,
      rationale:
        'Staged candidate value failed durability or safety guardrails.',
    };
  }
  if (
    candidate.reason &&
    (candidate.reason.length > MAX_DREAM_WHY_CHARS ||
      !isSafeMemoryText(candidate.reason))
  ) {
    return {
      ok: false,
      rationale: 'Staged candidate rationale failed safety guardrails.',
    };
  }
  if (parseJsonArray(candidate.evidenceIdsJson).length === 0) {
    return {
      ok: false,
      rationale: 'Staged candidate has no grounded evidence ids.',
    };
  }
  return {
    ok: true,
    rationale: 'Deep dreaming validated a structured candidate for apply.',
  };
}

export function extractMemoryValue(row: MemoryItemRow): string {
  const payload = parseJsonObject(row.valueJson);
  return typeof payload.value === 'string' ? payload.value : '';
}
