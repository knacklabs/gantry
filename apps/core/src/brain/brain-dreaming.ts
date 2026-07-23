import { randomUUID } from 'node:crypto';

import { nowIso } from '../shared/time/datetime.js';
import {
  MemoryLlmBrainDreamProposer,
  type BrainDreamProposal,
  type BrainDreamProposalPort,
} from './brain-dream-proposer.js';
import {
  normalizeBrainSlug,
  normalizeEntityName,
} from './brain-page-ingest.js';
import type { BrainRepository } from './brain-repository.js';
import type { BrainService } from './brain-service.js';
import type { ObserverInsightEmissionRuntime } from './observer-insight-emission.js';
import {
  emitObserverInsights,
  normalizeSurfaceableInsightDraft,
} from './observer-insight-emission.js';
import {
  BRAIN_EDGE_TYPES,
  BRAIN_ENTITY_KINDS,
  type BrainEdgeType,
  type BrainEntityKind,
  type BrainPage,
} from './brain-types.js';

export {
  dreamMarkdownWindow,
  MemoryLlmBrainDreamProposer,
  type BrainDreamProposal,
  type BrainDreamProposalPort,
} from './brain-dream-proposer.js';

export type BrainDreamOutcome = 'applied' | 'noop' | 'rejected' | 'proposed';

export interface BrainDreamBatchResult {
  runId: string;
  pages: number;
  applied: number;
  noop: number;
  rejected: number;
  proposed: number;
  observer?: {
    persisted: number;
    deduplicated: number;
    filtered: number;
    message: string;
  };
}

const DESTRUCTIVE_ACTIONS = new Set([
  'merge_entities',
  'retire_page',
  'delete_page',
  'delete_entity',
  'delete_edge',
  'rewrite_page',
]);

export async function runBrainDreamBatch(input: {
  brain: BrainService;
  repository: BrainRepository;
  appId: string;
  proposer?: BrainDreamProposalPort;
  limit?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  observer?: ObserverInsightEmissionRuntime;
}): Promise<BrainDreamBatchResult> {
  if (input.observer?.enabled) {
    return runObserverBrainDreamBatch({ ...input, observer: input.observer });
  }
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
    const ops = (await proposer.propose({
      appId: input.appId,
      pages: [page],
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    })) as unknown[];
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

async function runObserverBrainDreamBatch(input: {
  brain: BrainService;
  repository: BrainRepository;
  appId: string;
  proposer?: BrainDreamProposalPort;
  limit?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  observer: ObserverInsightEmissionRuntime & { enabled: true };
}): Promise<BrainDreamBatchResult> {
  const runId = `bdr_${randomUUID().replace(/-/g, '')}`;
  const proposer = input.proposer ?? new MemoryLlmBrainDreamProposer();
  const [brainCursor, observerCursor] = await Promise.all([
    input.repository.getDreamCursor(input.appId),
    input.observer.repository.getInsightCursor(
      input.appId,
      input.observer.cursorSubject,
    ),
  ]);
  const [brainPages, observerPages] = await Promise.all([
    input.repository.listPagesForDream({
      appId: input.appId,
      cursor: brainCursor,
      limit: input.limit ?? 25,
    }),
    input.repository.listPagesForDream({
      appId: input.appId,
      cursor: observerCursor,
      limit: input.limit ?? 25,
    }),
  ]);
  const brainPageIds = new Set(brainPages.map((page) => page.id));
  const observerPageIds = new Set(observerPages.map((page) => page.id));
  const pages = [
    ...new Map(
      [...brainPages, ...observerPages].map((page) => [page.id, page]),
    ).values(),
  ].sort(compareBrainPages);
  const result: BrainDreamBatchResult = {
    runId,
    pages: 0,
    applied: 0,
    noop: 0,
    rejected: 0,
    proposed: 0,
  };
  const drafts: Array<{
    draft: NonNullable<ReturnType<typeof normalizeSurfaceableInsightDraft>>;
    page: BrainPage;
  }> = [];

  for (const page of pages) {
    input.signal?.throwIfAborted();
    const rawProposal = await proposer.propose({
      appId: input.appId,
      pages: [page],
      observerEnabled: true,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    input.signal?.throwIfAborted();
    const proposal = normalizeBrainDreamProposal(rawProposal);
    result.pages += 1;
    if (brainPageIds.has(page.id)) {
      const summary = await applyBrainDreamOperations({
        brain: input.brain,
        repository: input.repository,
        appId: input.appId,
        runId,
        page,
        evidencePages: [page],
        ops: proposal.operations,
        signal: input.signal,
      });
      result.applied += summary.applied;
      result.noop += summary.noop;
      result.rejected += summary.rejected;
      result.proposed += summary.proposed;
      input.signal?.throwIfAborted();
      await input.repository.saveDreamCursor(input.appId, {
        updatedAt: page.updatedAt,
        pageId: page.id,
      });
    }
    if (observerPageIds.has(page.id)) {
      for (const rawDraft of proposal.surfaceableInsights) {
        const draft = normalizeSurfaceableInsightDraft(rawDraft, page.id);
        if (draft) drafts.push({ draft, page });
      }
    }
  }

  result.observer = await emitObserverInsights({
    ...input.observer,
    appId: input.appId,
    drafts,
    cursor: observerCursor,
    cursorTarget: [...observerPages].sort(compareBrainPages).at(-1),
    signal: input.signal,
  });
  return result;
}

function normalizeBrainDreamProposal(
  proposal: unknown[] | BrainDreamProposal,
): BrainDreamProposal {
  if (
    Array.isArray(proposal) ||
    !Array.isArray(proposal.operations) ||
    !Array.isArray(proposal.surfaceableInsights)
  ) {
    throw new Error(
      'Brain dreaming observer proposal requires operations and surfaceableInsights arrays',
    );
  }
  return {
    operations: proposal.operations,
    surfaceableInsights: proposal.surfaceableInsights,
  };
}

function compareBrainPages(left: BrainPage, right: BrainPage): number {
  const time = left.updatedAt.localeCompare(right.updatedAt);
  return time || left.id.localeCompare(right.id);
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
