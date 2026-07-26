import * as p from '@clack/prompts';
import {
  isEmbeddingProviderRegistered,
  validateEmbeddingProviderReady,
} from '../memory/memory-embeddings.js';

import { controlApiRequest } from './control-api.js';
import type { MemoryReviewRecord } from '../memory/memory-types.js';
import { readEnvFile } from '../config/env/file.js';
import {
  collectMemoryStatus,
  formatMemoryStatusExtras,
} from './memory-status.js';
import { inspectMemoryHealth } from './memory-health.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import {
  DEFAULT_EMBED_DIMENSIONS,
  DEFAULT_EMBED_MODEL,
  getProviderManagedMemoryDefaults,
  loadRuntimeSettings,
  noteRestartRequired,
  writeDesiredRuntimeSettings,
  type EmbeddingProviderName,
} from '../config/settings/runtime-settings.js';
import { runEmbeddingBackfillCommand } from './memory-embeddings-backfill.js';

function usage(): string {
  return [
    'Usage:',
    '  gantry memory status [--json]',
    '  gantry memory embeddings <off|disabled|openai>',
    '  gantry memory embeddings backfill [--limit N] [--mode auto|inline|provider_batch]',
    '  gantry memory dreaming <on|off>',
    '  gantry model memory',
    '  gantry model reset memory',
    '',
    reviewUsage(),
  ].join('\n');
}

function reviewUsage(): string {
  return [
    'Usage:',
    '  gantry memory reviews --agent-id <id> --subject-type <user|group|channel|common> --subject-id <id> [--json]',
    '  gantry memory review <reviewId> --agent-id <id> --subject-type <t> --subject-id <id> [--json]',
    '  gantry memory review decide <reviewId> --agent-id <id> --subject-type <t> --subject-id <id> (--approve | --reject | --edit-value <value>) [--reason <reason>] [--json]',
  ].join('\n');
}

interface ReviewFlags {
  agentId?: string;
  subjectType?: string;
  subjectId?: string;
  json: boolean;
  approve: boolean;
  reject: boolean;
  editValue?: string;
  reason?: string;
}

function parseReviewFlags(args: string[]): ReviewFlags {
  const flags: ReviewFlags = { json: false, approve: false, reject: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--agent-id' && next) {
      flags.agentId = next;
      index += 1;
    } else if (arg === '--subject-type' && next) {
      flags.subjectType = next;
      index += 1;
    } else if (arg === '--subject-id' && next) {
      flags.subjectId = next;
      index += 1;
    } else if (arg === '--reason' && next) {
      flags.reason = next;
      index += 1;
    } else if (arg === '--edit-value' && next) {
      flags.editValue = next;
      index += 1;
    } else if (arg === '--approve') {
      flags.approve = true;
    } else if (arg === '--reject') {
      flags.reject = true;
    } else if (arg === '--json') {
      flags.json = true;
    }
  }
  return flags;
}

// agentId/subjectType/subjectId are REQUIRED — a review is always scoped to one
// subject (the control API enforces the same; this is a fast local guard).
function reviewSubjectParams(flags: ReviewFlags): URLSearchParams | null {
  if (!flags.agentId || !flags.subjectType || !flags.subjectId) return null;
  const params = new URLSearchParams();
  params.set('agentId', flags.agentId);
  params.set('subjectType', flags.subjectType);
  params.set('subjectId', flags.subjectId);
  return params;
}

function reviewErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function short(value: string | undefined, max = 32): string {
  if (!value) return '—';
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

interface ReviewListItem {
  review_id: string;
  action: string;
  summary: string;
  before?: { kind?: string; key?: string; value?: string } | null;
  after?: { kind?: string; key?: string; value?: string } | null;
  target?: { kind?: string; key?: string; value?: string } | null;
}

interface ReviewListResponse {
  reviews?: Array<{ id: string; createdAt: string }>;
  review_page?: { items?: ReviewListItem[] };
}

async function listReviews(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const flags = parseReviewFlags(args);
  const params = reviewSubjectParams(flags);
  if (!params) {
    p.log.error(reviewUsage());
    return 1;
  }
  let data: ReviewListResponse;
  try {
    data = (await controlApiRequest(runtimeHome, {
      method: 'GET',
      path: `/v1/memory/reviews?${params}`,
    })) as ReviewListResponse;
  } catch (err) {
    p.log.error(reviewErrorMessage(err));
    return 1;
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }
  const items = data.review_page?.items ?? [];
  if (items.length === 0) {
    p.note('No pending reviews.', 'Memory Reviews');
    return 0;
  }
  const createdById = new Map(
    (data.reviews ?? []).map((review) => [review.id, review.createdAt]),
  );
  p.note(formatReviewTable(items, createdById), 'Memory Reviews');
  return 0;
}

function formatReviewTable(
  items: ReviewListItem[],
  createdById: Map<string, string>,
): string {
  const rows = items.map((item) => [
    item.review_id,
    item.action,
    short(
      item.before?.key ?? item.after?.key ?? item.target?.key ?? item.summary,
    ),
    `${short(item.before?.value ?? item.target?.value, 24)} → ${
      item.after?.value ? short(item.after.value, 24) : item.action
    }`,
    createdById.get(item.review_id) ?? '',
  ]);
  const headers = ['Review', 'Kind', 'Topic', 'Now → Change', 'Created'];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  return [headers, ...rows]
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

async function showReview(
  runtimeHome: string,
  reviewId: string | undefined,
  args: string[],
): Promise<number> {
  const flags = parseReviewFlags(args);
  const params = reviewSubjectParams(flags);
  if (!reviewId || !params) {
    p.log.error(reviewUsage());
    return 1;
  }
  let data: { review?: MemoryReviewRecord };
  try {
    data = (await controlApiRequest(runtimeHome, {
      method: 'GET',
      path: `/v1/memory/reviews/${encodeURIComponent(reviewId)}?${params}`,
    })) as { review?: MemoryReviewRecord };
  } catch (err) {
    p.log.error(reviewErrorMessage(err));
    return 1;
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }
  if (!data.review) {
    p.log.error('Review not found');
    return 1;
  }
  p.note(formatReviewDetail(data.review), `Memory Review ${reviewId}`);
  return 0;
}

function formatClaim(claim: {
  kind?: string;
  key?: string;
  value?: string;
}): string {
  return `  ${claim.kind ?? '(kind)'} ${claim.key ?? '(key)'} = ${claim.value ?? ''}`;
}

function formatReviewDetail(review: MemoryReviewRecord): string {
  const lines = [
    `Review: ${review.id}`,
    `Status: ${review.status}`,
    `Action: ${review.proposal?.action ?? review.proposedChange?.action ?? '(unknown)'}`,
    `Created: ${review.createdAt}`,
  ];
  const snapshot = review.reviewSnapshot;
  if (!snapshot) {
    lines.push('', '(no immutable snapshot captured for this review)');
    return lines.join('\n');
  }
  const active = snapshot.conflict?.active;
  if (active) lines.push('', 'Now (active claim):', formatClaim(active));
  const incoming = snapshot.conflict?.incoming;
  if (incoming)
    lines.push('', 'Change (incoming claim):', formatClaim(incoming));
  const proposed = snapshot.proposedCanonical;
  if (proposed) {
    lines.push(
      '',
      'Proposed canonical:',
      `  ${proposed.kind} ${proposed.key} = ${proposed.value}`,
      `  Why: ${proposed.reason}`,
    );
  }
  if (snapshot.retiring?.length) {
    lines.push('', 'Retiring:', ...snapshot.retiring.map(formatClaim));
  }
  if (snapshot.evidence?.length) {
    lines.push('', 'Evidence:');
    for (const evidence of snapshot.evidence) {
      lines.push(
        `  [${evidence.role}] ${evidence.sourceType}${
          evidence.sourceUri ? ` (${evidence.sourceUri})` : ''
        }`,
        `    ${evidence.text}`,
      );
    }
  }
  return lines.join('\n');
}

async function decideReview(
  runtimeHome: string,
  reviewId: string | undefined,
  args: string[],
): Promise<number> {
  const flags = parseReviewFlags(args);
  const params = reviewSubjectParams(flags);
  if (!reviewId || !params) {
    p.log.error(reviewUsage());
    return 1;
  }
  const chosen =
    Number(flags.approve) +
    Number(flags.reject) +
    Number(flags.editValue !== undefined);
  if (chosen !== 1) {
    p.log.error(
      'Provide exactly one of --approve, --reject, or --edit-value <value>.',
    );
    return 1;
  }
  const decision = flags.approve
    ? 'approve'
    : flags.reject
      ? 'reject'
      : 'edit_approve';
  const body = {
    decision,
    ...(flags.editValue !== undefined ? { editedValue: flags.editValue } : {}),
    ...(flags.reason !== undefined ? { reason: flags.reason } : {}),
  };
  let data: { review?: MemoryReviewRecord };
  try {
    data = (await controlApiRequest(runtimeHome, {
      method: 'POST',
      path: `/v1/memory/reviews/${encodeURIComponent(reviewId)}/decision?${params}`,
      body,
    })) as { review?: MemoryReviewRecord };
  } catch (err) {
    p.log.error(reviewErrorMessage(err));
    return 1;
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }
  const review = data.review;
  p.log.success(
    `Review ${reviewId}: ${review?.status ?? 'decided'}${
      review?.applyOutcome ? ` (${review.applyOutcome})` : ''
    }`,
  );
  return 0;
}

interface EffectiveModelRow {
  model: string;
  source: 'settings.yaml' | 'settings.yaml agent.default_model' | 'default';
}

function resolveEffectiveModel(
  configuredModel: string | undefined,
  globalModel: string | undefined,
  hardDefault: string,
): EffectiveModelRow {
  const configured = configuredModel?.trim();
  if (configured) {
    return { model: configured, source: 'settings.yaml' };
  }
  const global = globalModel?.trim();
  if (global) {
    return { model: global, source: 'settings.yaml agent.default_model' };
  }
  return { model: hardDefault, source: 'default' };
}

function formatMemoryStatus(runtimeHome: string): string {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const health = inspectMemoryHealth(runtimeHome, settings, env);
  const globalModel = settings.agent.defaultModel;
  const hardDefaults = getProviderManagedMemoryDefaults();
  const extractorModel = resolveEffectiveModel(
    settings.memory.llm.models.extractor,
    globalModel,
    hardDefaults.extractor,
  );
  const dreamingModel = resolveEffectiveModel(
    settings.memory.llm.models.dreaming,
    globalModel,
    hardDefaults.dreaming,
  );
  const consolidationModel = resolveEffectiveModel(
    settings.memory.llm.models.consolidation,
    globalModel,
    hardDefaults.consolidation,
  );
  const brokerConfigured = settings.credentialBroker.mode === 'gantry';
  return [
    'Gantry Memory',
    '',
    `Memory: ${health.memoryEnabled ? 'on' : 'off'} (source: ${health.memorySource})`,
    `Pre-answer recall: ${health.memoryEnabled ? 'on' : 'off'}`,
    `Search mode: ${health.embeddingsEnabled ? 'hybrid when indexed' : 'full-text'}`,
    `Semantic recall: ${health.embeddingsEnabled ? 'on' : 'off (optional)'} (run /memory-status for live ready/pending counts)`,
    `Storage: ${health.memoryCheck.status}`,
    `Storage backend: ${health.storageProvider} (source: settings.yaml)`,
    'Memory tables: Postgres runtime schema (app boundaries, evidence, recall, dreaming)',
    `Embeddings: ${health.embeddingsEnabled ? 'on' : 'off'}`,
    `Embedding provider: ${health.embeddingProvider} (${health.embeddingCheck.status}, source: ${health.embeddingProviderSource})`,
    `Embedding model: ${health.embeddingModel} (source: ${health.embeddingModelSource})`,
    `Dreaming: ${health.dreamingEnabled ? 'on' : 'off'} (source: ${health.dreamingSource})`,
    `Model Access: ${brokerConfigured ? 'configured' : 'missing'} (settings.yaml model_access)`,
    `Model extractor: ${extractorModel.model} (source: ${extractorModel.source})`,
    `Model dreaming: ${dreamingModel.model} (source: ${dreamingModel.source})`,
    `Model consolidation: ${consolidationModel.model} (source: ${consolidationModel.source})`,
  ].join('\n');
}

async function setEmbeddings(
  runtimeHome: string,
  provider: EmbeddingProviderName,
): Promise<{ ok: boolean; message?: string }> {
  const settings = loadRuntimeSettings(runtimeHome);
  const previousSettings = structuredClone(settings);
  if (provider === 'disabled') {
    settings.memory.embeddings.enabled = false;
  } else if (isEmbeddingProviderRegistered(provider)) {
    try {
      await validateEmbeddingProviderReady(provider);
    } catch (err) {
      return {
        ok: false,
        message: `Embedding provider "${provider}" is not ready: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    settings.memory.embeddings.enabled = true;
  } else {
    return {
      ok: false,
      message: `Unknown embedding provider "${provider}". Use openai, or keep embeddings off.`,
    };
  }
  settings.memory.embeddings.provider = provider;
  if (provider !== 'disabled') {
    // v1 semantic memory only supports 1536-dim text-embedding-3-small vectors.
    settings.memory.embeddings.model = DEFAULT_EMBED_MODEL;
    settings.memory.embeddings.dimensions = DEFAULT_EMBED_DIMENSIONS;
  } else if (!settings.memory.embeddings.model.trim()) {
    settings.memory.embeddings.model = DEFAULT_EMBED_MODEL;
  }
  const result = await writeDesiredRuntimeSettings({
    runtimeHome,
    settings,
    previousSettings,
  });
  noteRestartRequired(result);
  return { ok: true };
}

async function setDreaming(
  runtimeHome: string,
  enabled: boolean,
): Promise<void> {
  const settings = loadRuntimeSettings(runtimeHome);
  const previousSettings = structuredClone(settings);
  settings.memory.dreaming.enabled = enabled;
  if (enabled && !settings.memory.enabled) settings.memory.enabled = true;
  const result = await writeDesiredRuntimeSettings({
    runtimeHome,
    settings,
    previousSettings,
  });
  noteRestartRequired(result);
}

export async function runMemoryCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, value] = args;

  if (!command || command === 'status') {
    const statusFlags = command ? args.slice(1) : [];
    const jsonMode = statusFlags.includes('--json');
    const snapshot = collectMemoryStatus(runtimeHome);
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      return 0;
    }
    p.note(formatMemoryStatus(runtimeHome), 'Memory');
    p.note(formatMemoryStatusExtras(snapshot), 'Memory Runtime');
    return 0;
  }

  if (command === 'embeddings' && value === 'backfill') {
    return runEmbeddingBackfillCommand(runtimeHome, args.slice(2));
  }

  if (command === 'embeddings') {
    const normalized = value === 'off' ? 'disabled' : value;
    if (!normalized || !/^[a-z][a-z0-9_-]{0,62}$/.test(normalized)) {
      p.log.error(usage());
      return 1;
    }
    const result = await setEmbeddings(
      runtimeHome,
      normalized as EmbeddingProviderName,
    );
    if (!result.ok) {
      p.log.error(result.message || 'Could not update embeddings settings.');
      return 1;
    }
    p.log.success(`Memory embeddings set to ${normalized} in settings.yaml.`);
    return 0;
  }

  if (command === 'reviews') {
    return listReviews(runtimeHome, args.slice(1));
  }

  if (command === 'review') {
    if (value === 'decide') {
      return decideReview(runtimeHome, args[2], args.slice(3));
    }
    return showReview(runtimeHome, value, args.slice(2));
  }

  if (command === 'dreaming') {
    if (value !== 'on' && value !== 'off') {
      p.log.error(usage());
      return 1;
    }
    await setDreaming(runtimeHome, value === 'on');
    p.log.success(`Memory dreaming set to ${value} in settings.yaml.`);
    return 0;
  }

  p.log.error(usage());
  return 1;
}
