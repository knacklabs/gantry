import { randomUUID } from 'node:crypto';

import { getMemoryModelRuntimeConfig } from '../config/index.js';
import type { AppId } from '../domain/app/app.js';
import { getMemoryLlmClient } from '../memory/memory-llm-port.js';
import { nowIso } from '../shared/time/datetime.js';
import {
  normalizeBrainSlug,
  normalizeEntityName,
} from './brain-page-ingest.js';
import type { BrainRepository } from './brain-repository.js';
import type { BrainService } from './brain-service.js';
import {
  BRAIN_EDGE_TYPES,
  BRAIN_ENTITY_KINDS,
  type BrainEdgeType,
  type BrainEntityKind,
  type BrainPage,
} from './brain-types.js';

export type BrainDreamOutcome = 'applied' | 'noop' | 'rejected' | 'proposed';

export interface BrainDreamProposalPort {
  propose(input: {
    appId: string;
    pages: BrainPage[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<unknown[]>;
}

export interface BrainDreamBatchResult {
  runId: string;
  pages: number;
  applied: number;
  noop: number;
  rejected: number;
  proposed: number;
}

const BRAIN_DREAM_PROMPT = [
  'You consolidate Gantry company brain pages into grounded knowledge.',
  'Return strict JSON array operations only.',
  'Allowed additive operations:',
  '{"action":"upsert_entity","kind":"person|company|project|topic","name":"name"}',
  '{"action":"upsert_edge","type":"works_at|member_of|mentions|authored|assigned_to|relates_to","from":{"kind":"person|company|project|topic","name":"name"},"to":{"kind":"person|company|project|topic","name":"name"},"evidencePageId":"page id"}',
  '{"action":"write_fact_page","topic":"stable topic","title":"title","markdown":"short durable fact page","evidencePageIds":["page id"]}',
  '{"action":"enrich_entity_page","kind":"person|company|project|topic","name":"name","markdown":"short entity summary","evidencePageIds":["page id"]}',
  'Destructive operations may be proposed, but the host journals them without applying.',
  'Use only supplied page ids as evidence.',
].join('\n');

const DESTRUCTIVE_ACTIONS = new Set([
  'merge_entities',
  'retire_page',
  'delete_page',
  'delete_entity',
  'delete_edge',
  'rewrite_page',
]);

export class MemoryLlmBrainDreamProposer implements BrainDreamProposalPort {
  async propose(input: {
    appId: string;
    pages: BrainPage[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<unknown[]> {
    const llm = getMemoryLlmClient();
    if (!llm.isConfigured()) {
      throw new Error('Brain dreaming LLM client is not configured');
    }
    const { dreaming: model, modelProfiles } = getMemoryModelRuntimeConfig();
    const payload = {
      pages: input.pages.slice(0, 10).map((page) => ({
        id: page.id,
        slug: page.slug,
        title: page.title,
        sourceKind: page.sourceKind,
        markdown: dreamMarkdownWindow(page.markdown),
        metadata: page.metadata,
      })),
    };
    const text = await llm.query({
      appId: input.appId as AppId,
      model,
      modelProfile: modelProfiles?.dreaming,
      systemPrompt: BRAIN_DREAM_PROMPT,
      prompt: `${BRAIN_DREAM_PROMPT}\n\n${JSON.stringify(payload, null, 2)}`,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    input.signal?.throwIfAborted();
    return parseJsonArray(text);
  }
}

export async function runBrainDreamBatch(input: {
  brain: BrainService;
  repository: BrainRepository;
  appId: string;
  proposer?: BrainDreamProposalPort;
  limit?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<BrainDreamBatchResult> {
  const runId = `bdr_${randomUUID().replace(/-/g, '')}`;
  const proposer = input.proposer ?? new MemoryLlmBrainDreamProposer();
  const cursor = await input.repository.getDreamCursor(input.appId);
  const pages = await input.repository.listPagesForDream({
    appId: input.appId,
    cursor,
    limit: input.limit ?? 25,
  });
  const result: BrainDreamBatchResult = {
    runId,
    pages: 0,
    applied: 0,
    noop: 0,
    rejected: 0,
    proposed: 0,
  };
  for (const page of pages) {
    input.signal?.throwIfAborted();
    const ops = await proposer.propose({
      appId: input.appId,
      pages: [page],
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    input.signal?.throwIfAborted();
    const summary = await applyBrainDreamOperations({
      brain: input.brain,
      repository: input.repository,
      appId: input.appId,
      runId,
      page,
      evidencePages: [page],
      ops,
      signal: input.signal,
    });
    result.applied += summary.applied;
    result.noop += summary.noop;
    result.rejected += summary.rejected;
    result.proposed += summary.proposed;
    result.pages += 1;
    input.signal?.throwIfAborted();
    await input.repository.saveDreamCursor(input.appId, {
      updatedAt: page.updatedAt,
      pageId: page.id,
    });
  }
  return result;
}

// ponytail: bounded recency window — new harvest lines append at the tail,
// so the tail always reaches the model. First dream of a page already past
// the cap misses the oldest prefix; track a per-page dreamed offset if that
// ever matters.
export function dreamMarkdownWindow(markdown: string): string {
  const CAP = 5000;
  if (markdown.length <= CAP) return markdown;
  return `…${markdown.slice(-CAP)}`;
}

export async function applyBrainDreamOperations(input: {
  brain: BrainService;
  repository: BrainRepository;
  appId: string;
  runId: string;
  page?: BrainPage;
  evidencePages: BrainPage[];
  ops: unknown[];
  signal?: AbortSignal;
}): Promise<Omit<BrainDreamBatchResult, 'runId' | 'pages'>> {
  const evidenceById = new Map(
    input.evidencePages.map((page) => [page.id, page]),
  );
  const summary = { applied: 0, noop: 0, rejected: 0, proposed: 0 };
  for (const raw of input.ops) {
    input.signal?.throwIfAborted();
    const op = normalizeOperation(raw);
    let outcome: BrainDreamOutcome = 'rejected';
    let reason = op.valid ? '' : op.reason;
    if (op.valid) {
      if (op.kind === 'destructive') {
        outcome = 'proposed';
        reason = 'destructive operation is journaled for later review';
      } else {
        const applied = await applyOperation({
          ...input,
          evidenceById,
          op,
        });
        outcome = applied.outcome;
        reason = applied.reason;
      }
    }
    await input.repository.journalDreamDecision({
      id: `bdd_${randomUUID().replace(/-/g, '')}`,
      appId: input.appId,
      runId: input.runId,
      pageId: input.page?.id ?? null,
      op:
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : { invalid: raw },
      outcome,
      reason,
    });
    summary[outcome] += 1;
  }
  return summary;
}

type NormalizedOperation =
  | { valid: false; reason: string }
  | { valid: true; kind: 'destructive'; action: string }
  | {
      valid: true;
      kind: 'upsert_entity';
      entityKind: BrainEntityKind;
      name: string;
    }
  | {
      valid: true;
      kind: 'upsert_edge';
      type: BrainEdgeType;
      from: { kind: BrainEntityKind; name: string };
      to: { kind: BrainEntityKind; name: string };
      evidencePageId: string;
    }
  | {
      valid: true;
      kind: 'write_fact_page';
      topic: string;
      title: string;
      markdown: string;
      evidencePageIds: string[];
    }
  | {
      valid: true;
      kind: 'enrich_entity_page';
      entityKind: BrainEntityKind;
      name: string;
      markdown: string;
      evidencePageIds: string[];
    };
type AdditiveOperation = Exclude<
  Extract<NormalizedOperation, { valid: true }>,
  { kind: 'destructive' }
>;

async function applyOperation(input: {
  brain: BrainService;
  repository: BrainRepository;
  appId: string;
  evidenceById: Map<string, BrainPage>;
  op: AdditiveOperation;
}): Promise<{ outcome: BrainDreamOutcome; reason: string }> {
  switch (input.op.kind) {
    case 'upsert_entity':
      return upsertEntity(
        input.repository,
        input.appId,
        input.op.entityKind,
        input.op.name,
      );
    case 'upsert_edge':
      return upsertEdge({
        repository: input.repository,
        appId: input.appId,
        evidenceById: input.evidenceById,
        op: input.op,
      });
    case 'write_fact_page':
      return writeDreamPage(input, {
        slug: `fact-${normalizeBrainSlug(input.op.topic || input.op.title)}`,
        title: input.op.title || input.op.topic,
        markdown: input.op.markdown,
        evidencePageIds: input.op.evidencePageIds,
      });
    case 'enrich_entity_page':
      return writeDreamPage(input, {
        slug: `entity-${input.op.entityKind}-${normalizeBrainSlug(input.op.name)}`,
        title: `${input.op.name} (${input.op.entityKind})`,
        markdown: input.op.markdown,
        evidencePageIds: input.op.evidencePageIds,
      });
  }
}

async function upsertEntity(
  repository: BrainRepository,
  appId: string,
  kind: BrainEntityKind,
  name: string,
): Promise<{ outcome: BrainDreamOutcome; reason: string }> {
  const normalizedName = normalizeEntityName(name);
  const existing = await repository.getEntityByName(
    appId,
    kind,
    normalizedName,
  );
  await repository.upsertEntities(appId, [{ kind, name, normalizedName }]);
  return existing
    ? { outcome: 'noop', reason: 'entity already exists' }
    : { outcome: 'applied', reason: 'entity upserted' };
}

async function upsertEdge(input: {
  repository: BrainRepository;
  appId: string;
  evidenceById: Map<string, BrainPage>;
  op: Extract<NormalizedOperation, { kind: 'upsert_edge' }>;
}): Promise<{ outcome: BrainDreamOutcome; reason: string }> {
  const evidence = input.evidenceById.get(input.op.evidencePageId);
  if (!evidence)
    return { outcome: 'rejected', reason: 'evidence page not found' };
  const [from] = await input.repository.upsertEntities(input.appId, [
    {
      kind: input.op.from.kind,
      name: input.op.from.name,
      normalizedName: normalizeEntityName(input.op.from.name),
    },
  ]);
  const [to] = await input.repository.upsertEntities(input.appId, [
    {
      kind: input.op.to.kind,
      name: input.op.to.name,
      normalizedName: normalizeEntityName(input.op.to.name),
    },
  ]);
  if (!from || !to)
    return { outcome: 'rejected', reason: 'edge entity missing' };
  const existing = await input.repository.getEdge({
    appId: input.appId,
    type: input.op.type,
    fromEntityId: from.id,
    toEntityId: to.id,
    evidencePageId: evidence.id,
  });
  await input.repository.upsertEdges(input.appId, evidence.id, [
    { type: input.op.type, fromEntityId: from.id, toEntityId: to.id },
  ]);
  return existing
    ? { outcome: 'noop', reason: 'edge already exists' }
    : { outcome: 'applied', reason: 'edge upserted' };
}

async function writeDreamPage(
  input: {
    brain: BrainService;
    appId: string;
    evidenceById: Map<string, BrainPage>;
  },
  page: {
    slug: string;
    title: string;
    markdown: string;
    evidencePageIds: string[];
  },
): Promise<{ outcome: BrainDreamOutcome; reason: string }> {
  const evidencePageIds = [...new Set(page.evidencePageIds)].filter((id) =>
    input.evidenceById.has(id),
  );
  if (evidencePageIds.length === 0) {
    return { outcome: 'rejected', reason: 'no valid evidence pages' };
  }
  const existing = await input.brain.getPageBySlug(input.appId, page.slug);
  if (existing && existing.sourceKind !== 'dream') {
    // Additive ops must never replace user/import/agent/channel pages; a
    // colliding deterministic slug is journaled instead of applied.
    return {
      outcome: 'rejected',
      reason: `slug ${page.slug} collides with a ${existing.sourceKind} page`,
    };
  }
  const markdown = markdownWithFrontmatter(
    {
      title: page.title,
      source_kind: 'dream',
      evidence_page_ids: evidencePageIds,
      dreamed_at: nowIso(),
    },
    page.markdown,
  );
  const parsedBody = page.markdown.trim();
  const unchanged =
    existing?.sourceKind === 'dream' &&
    existing.title === page.title &&
    existing.markdown === parsedBody &&
    JSON.stringify(existing.metadata.evidence_page_ids ?? []) ===
      JSON.stringify(evidencePageIds);
  if (!unchanged) {
    await input.brain.write({
      appId: input.appId,
      slug: page.slug,
      title: page.title,
      markdown,
      sourceKind: 'dream',
      sourceRef: evidencePageIds.join(','),
      embed: false,
    });
  }
  return unchanged
    ? { outcome: 'noop', reason: 'dream page already current' }
    : { outcome: 'applied', reason: 'dream page written' };
}

function normalizeOperation(raw: unknown): NormalizedOperation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: 'operation must be an object' };
  }
  const row = raw as Record<string, unknown>;
  const action = stringValue(row.action);
  if (!action) return { valid: false, reason: 'operation action is required' };
  if (DESTRUCTIVE_ACTIONS.has(action)) {
    return { valid: true, kind: 'destructive', action };
  }
  if (action === 'upsert_entity') {
    const kind = entityKind(row.kind);
    const name = stringValue(row.name);
    return kind && name
      ? { valid: true, kind: 'upsert_entity', entityKind: kind, name }
      : { valid: false, reason: 'upsert_entity requires kind and name' };
  }
  if (action === 'upsert_edge') {
    const type = edgeType(row.type);
    const from = entityRef(row.from);
    const to = entityRef(row.to);
    const evidencePageId = stringValue(
      row.evidencePageId ?? row.evidence_page_id,
    );
    return type && from && to && evidencePageId
      ? { valid: true, kind: 'upsert_edge', type, from, to, evidencePageId }
      : {
          valid: false,
          reason: 'upsert_edge requires type, from, to, and evidencePageId',
        };
  }
  if (action === 'write_fact_page') {
    const topic = stringValue(row.topic);
    const title = stringValue(row.title) || topic;
    const markdown = stringValue(row.markdown);
    const evidencePageIds = stringArray(
      row.evidencePageIds ?? row.evidence_page_ids,
    );
    return topic && title && markdown && evidencePageIds.length > 0
      ? {
          valid: true,
          kind: 'write_fact_page',
          topic,
          title,
          markdown,
          evidencePageIds,
        }
      : {
          valid: false,
          reason:
            'write_fact_page requires topic, markdown, and evidencePageIds',
        };
  }
  if (action === 'enrich_entity_page') {
    const kind = entityKind(row.kind);
    const name = stringValue(row.name);
    const markdown = stringValue(row.markdown);
    const evidencePageIds = stringArray(
      row.evidencePageIds ?? row.evidence_page_ids,
    );
    return kind && name && markdown && evidencePageIds.length > 0
      ? {
          valid: true,
          kind: 'enrich_entity_page',
          entityKind: kind,
          name,
          markdown,
          evidencePageIds,
        }
      : {
          valid: false,
          reason:
            'enrich_entity_page requires kind, name, markdown, and evidencePageIds',
        };
  }
  return { valid: false, reason: `unsupported operation action: ${action}` };
}

function parseJsonArray(text: string): unknown[] {
  // Malformed model output must throw, not read as a valid empty op list:
  // the batch loop saves the dream cursor after each page, and silently
  // returning [] would permanently skip the page.
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first < 0 || last < first) {
    throw new Error('brain dream proposer returned no JSON array');
  }
  const parsed = JSON.parse(text.slice(first, last + 1)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('brain dream proposer returned non-array JSON');
  }
  return parsed;
}

function entityRef(
  value: unknown,
): { kind: BrainEntityKind; name: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const kind = entityKind(row.kind);
  const name = stringValue(row.name);
  return kind && name ? { kind, name } : null;
}

function entityKind(value: unknown): BrainEntityKind | null {
  return BRAIN_ENTITY_KINDS.includes(value as BrainEntityKind)
    ? (value as BrainEntityKind)
    : null;
}

function edgeType(value: unknown): BrainEdgeType | null {
  return BRAIN_EDGE_TYPES.includes(value as BrainEdgeType)
    ? (value as BrainEdgeType)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string => typeof entry === 'string' && !!entry.trim(),
      )
    : [];
}

function markdownWithFrontmatter(
  frontmatter: Record<string, string | string[]>,
  body: string,
): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(
        `${key}: [${value.map((entry) => JSON.stringify(entry)).join(', ')}]`,
      );
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push('---', body.trim());
  return lines.join('\n');
}
