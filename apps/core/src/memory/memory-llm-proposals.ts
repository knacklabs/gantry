import { getMemoryModelRuntimeConfig } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  parseItemSource,
  type CanonicalMemoryItemRow,
} from './app-memory-canonical-codec.js';
import { extractMemoryValue } from './app-memory-dreaming-candidate-guardrails.js';
import { getMemoryLlmClient } from './memory-llm-port.js';
import type {
  MemoryKind,
  MemoryLifecycleProposal,
  NormalizedMemorySubject,
} from './memory-types.js';

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
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<MemoryLifecycleProposal[]> {
  const memoryLlm = getMemoryLlmClient();
  if (!memoryLlm.isConfigured()) return [];
  input.signal?.throwIfAborted();
  const { dreaming: model, modelProfiles } = getMemoryModelRuntimeConfig();
  const payload = {
    subject: {
      app_id: input.subject.appId,
      agent_id: input.subject.agentId,
      subject_type: input.subject.subjectType,
      subject_id: input.subject.subjectId,
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
      modelProfile: modelProfiles?.dreaming,
      prompt: `${MEMORY_DREAMING_PROPOSAL_PROMPT}\n\n${JSON.stringify(payload, null, 2)}`,
      systemPrompt: MEMORY_DREAMING_PROPOSAL_PROMPT,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    input.signal?.throwIfAborted();
    return parseJsonArrayLoose(text)
      .map(normalizeLifecycleProposal)
      .filter((entry): entry is MemoryLifecycleProposal => Boolean(entry));
  } catch (err) {
    if (input.signal?.aborted) throw err;
    logger.warn({ err, model }, 'LLM memory dreaming proposal failed');
    return [];
  }
}

export async function proposeMemoryConsolidationActions(input: {
  subject: NormalizedMemorySubject;
  activeItems: CanonicalMemoryItemRow[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<MemoryLifecycleProposal[]> {
  const memoryLlm = getMemoryLlmClient();
  if (!memoryLlm.isConfigured()) return [];
  input.signal?.throwIfAborted();
  const { consolidation: model, modelProfiles } = getMemoryModelRuntimeConfig();
  const payload = {
    subject: {
      app_id: input.subject.appId,
      agent_id: input.subject.agentId,
      subject_type: input.subject.subjectType,
      subject_id: input.subject.subjectId,
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
      modelProfile: modelProfiles?.consolidation,
      prompt: `${MEMORY_CONSOLIDATION_PROPOSAL_PROMPT}\n\n${JSON.stringify(payload, null, 2)}`,
      systemPrompt: MEMORY_CONSOLIDATION_PROPOSAL_PROMPT,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    input.signal?.throwIfAborted();
    return parseJsonArrayLoose(text)
      .map(normalizeLifecycleProposal)
      .filter((entry): entry is MemoryLifecycleProposal => Boolean(entry));
  } catch (err) {
    if (input.signal?.aborted) throw err;
    logger.warn({ err, model }, 'LLM memory consolidation proposal failed');
    return [];
  }
}
