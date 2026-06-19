import type { NewMessage, ConversationRoute } from '../domain/types.js';
import type { RuntimeAgentSessionRepository } from '../domain/repositories/ops-repo.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import { selectedSkillDisplay } from '../domain/skills/skill-identity.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
} from '../domain/ports/repositories.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import { logger, redactString } from '../infrastructure/logging/logger.js';
import type { RunAgentOptions } from './agent-spawn-types.js';
import type {
  MemoryBoundaryDefaultScope,
  SessionMemoryCollector,
} from '../domain/ports/session-memory-collector.js';
import {
  PROVIDER_SESSION_FIELD_NAME_LIST,
  PROVIDER_SESSION_HANDLE_START_LIST,
  redactProviderSessionHandlesInText,
} from '../shared/provider-session-redaction.js';
import { resolveRuntimeExecutionProviderId } from './execution-provider-id.js';

export const RUNTIME_RESULT_SUMMARY_MAX_CHARS = 4_000;

const RUNTIME_RESULT_SUMMARY_TRUNCATION_PREFIX =
  '[output truncated; showing tail]\n';

export function truncateRuntimeResultSummary(
  value: string,
  maxChars: number,
): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return '';
  if (maxChars <= RUNTIME_RESULT_SUMMARY_TRUNCATION_PREFIX.length) {
    return value;
  }
  const prefix =
    maxChars > RUNTIME_RESULT_SUMMARY_TRUNCATION_PREFIX.length
      ? RUNTIME_RESULT_SUMMARY_TRUNCATION_PREFIX
      : '';
  const tailChars = Math.max(0, maxChars - prefix.length);
  return `${prefix}${value.slice(-tailChars)}`;
}

export function summarizeRuntimeResultForPersistence(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  return truncateRuntimeResultSummary(
    redactProviderSessionHandlesInText(value),
    RUNTIME_RESULT_SUMMARY_MAX_CHARS,
  );
}

export function createRuntimeResultSummaryAccumulator(input?: {
  maxChars?: number;
}): {
  append: (delta: string) => void;
  snapshot: () => string | null;
} {
  const maxChars = Math.max(
    0,
    Math.floor(input?.maxChars ?? RUNTIME_RESULT_SUMMARY_MAX_CHARS),
  );
  const prefix =
    maxChars > RUNTIME_RESULT_SUMMARY_TRUNCATION_PREFIX.length
      ? RUNTIME_RESULT_SUMMARY_TRUNCATION_PREFIX
      : '';
  const tailCapacity = Math.max(0, maxChars - prefix.length);
  let tail = '';
  let truncated = false;
  let hasNonWhitespace = false;

  return {
    append(delta) {
      if (!delta || maxChars <= 0) return;
      hasNonWhitespace ||= /\S/.test(delta);
      if (!truncated && tail.length + delta.length <= maxChars) {
        tail += delta;
        return;
      }
      truncated = true;
      if (tailCapacity <= 0) {
        tail = '';
        truncated = false;
        return;
      }
      if (delta.length >= tailCapacity) {
        tail = delta.slice(-tailCapacity);
        return;
      }
      tail = `${tail.slice(-(tailCapacity - delta.length))}${delta}`;
    },
    snapshot() {
      if (!hasNonWhitespace) return null;
      const summary = truncated ? `${prefix}${tail}` : tail;
      return summary.trim() || null;
    },
  };
}

const INTERNAL_OPEN_TAG = '<internal>';
const INTERNAL_CLOSE_TAG = '</internal>';
const PROVIDER_SESSION_FIELD_END_PATTERN =
  /\b(?:sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id)\s*(?::|=|\s)\s*[^\s"',}\]]*$/i;
const PROVIDER_SESSION_TOKEN_CHARS = /^[A-Za-z0-9._:-]*$/;
const STREAM_SANITIZER_MAX_CARRY_CHARS = 512;

function partialSuffixStart(value: string, candidates: readonly string[]) {
  const lowerValue = value.toLowerCase();
  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();
    const maxLength = Math.min(lowerCandidate.length - 1, lowerValue.length);
    for (let length = maxLength; length >= 2; length -= 1) {
      if (lowerValue.endsWith(lowerCandidate.slice(0, length))) {
        return value.length - length;
      }
    }
  }
  return -1;
}

function splitInternalCarry(value: string, done: boolean) {
  if (done) return { body: value, carry: '' };
  const partialStart = partialSuffixStart(value, [INTERNAL_OPEN_TAG]);
  if (partialStart < 0) return { body: value, carry: '' };
  return {
    body: value.slice(0, partialStart),
    carry: value.slice(partialStart),
  };
}

function stripInternalBlocksIncrementally(
  value: string,
  state: { insideInternal: boolean },
): string {
  let remaining = value;
  let out = '';
  while (remaining) {
    if (state.insideInternal) {
      const closeIndex = remaining.indexOf(INTERNAL_CLOSE_TAG);
      if (closeIndex < 0) return out;
      remaining = remaining.slice(closeIndex + INTERNAL_CLOSE_TAG.length);
      state.insideInternal = false;
      continue;
    }
    const openIndex = remaining.indexOf(INTERNAL_OPEN_TAG);
    if (openIndex < 0) {
      out += remaining;
      return out;
    }
    out += remaining.slice(0, openIndex);
    remaining = remaining.slice(openIndex + INTERNAL_OPEN_TAG.length);
    state.insideInternal = true;
  }
  return out;
}

function splitProviderSessionCarry(value: string, done: boolean) {
  if (done) return { body: value, carry: '' };
  let carryStart = value.length;
  const partialCandidates = [
    ...PROVIDER_SESSION_HANDLE_START_LIST,
    ...PROVIDER_SESSION_FIELD_NAME_LIST.map((name) => `"${name}"`),
    ...PROVIDER_SESSION_FIELD_NAME_LIST.map((name) => `'${name}'`),
  ];
  const partialStart = partialSuffixStart(value, partialCandidates);
  if (partialStart >= 0) carryStart = Math.min(carryStart, partialStart);

  for (const marker of PROVIDER_SESSION_HANDLE_START_LIST) {
    const markerIndex = value.lastIndexOf(marker);
    if (markerIndex >= 0) {
      const suffix = value.slice(markerIndex + marker.length);
      if (PROVIDER_SESSION_TOKEN_CHARS.test(suffix)) {
        carryStart = Math.min(carryStart, markerIndex);
      }
    }
  }

  const fieldMatch = PROVIDER_SESSION_FIELD_END_PATTERN.exec(value);
  if (fieldMatch?.index !== undefined) {
    carryStart = Math.min(carryStart, fieldMatch.index);
  }

  if (carryStart === value.length) return { body: value, carry: '' };
  const carry = value.slice(carryStart);
  if (carry.length <= STREAM_SANITIZER_MAX_CARRY_CHARS) {
    return { body: value.slice(0, carryStart), carry };
  }
  return {
    body: `${value.slice(0, carryStart)}[REDACTED]`,
    carry: '',
  };
}

export function createRuntimeUserVisibleResultAccumulator(input?: {
  maxChars?: number;
}): {
  append: (delta: string) => void;
  snapshot: () => string | null;
} {
  const bounded = createRuntimeResultSummaryAccumulator(input);
  const state = {
    carry: '',
    insideInternal: false,
  };
  const flush = (delta: string, done: boolean): void => {
    const { body: internalBody, carry: internalCarry } = splitInternalCarry(
      `${state.carry}${delta}`,
      done,
    );
    state.carry = internalCarry;
    const withoutInternal = stripInternalBlocksIncrementally(
      internalBody,
      state,
    );
    const { body: providerBody, carry: providerCarry } =
      splitProviderSessionCarry(withoutInternal, done);
    state.carry = `${providerCarry}${state.carry}`;
    const safe = redactProviderSessionHandlesInText(providerBody);
    if (safe) bounded.append(safe);
  };

  return {
    append(delta) {
      if (!delta) return;
      flush(delta, false);
    },
    snapshot() {
      flush('', true);
      state.carry = '';
      state.insideInternal = false;
      return bounded.snapshot();
    },
  };
}

export function createRuntimeUserVisibleStreamSanitizer(): {
  append: (delta: string) => string;
  finish: () => string;
} {
  const state = {
    carry: '',
    insideInternal: false,
  };
  const flush = (delta: string, done: boolean): string => {
    const { body: internalBody, carry: internalCarry } = splitInternalCarry(
      `${state.carry}${delta}`,
      done,
    );
    state.carry = internalCarry;
    const withoutInternal = stripInternalBlocksIncrementally(
      internalBody,
      state,
    );
    const { body: providerBody, carry: providerCarry } =
      splitProviderSessionCarry(withoutInternal, done);
    state.carry = `${providerCarry}${state.carry}`;
    return redactProviderSessionHandlesInText(providerBody);
  };

  return {
    append(delta) {
      if (!delta) return '';
      return flush(delta, false);
    },
    finish() {
      const safe = flush('', true);
      state.carry = '';
      state.insideInternal = false;
      return safe;
    },
  };
}

export async function archiveCurrentRuntimeSession(input: {
  ops: RuntimeAgentSessionRepository;
  appId?: string;
  group: ConversationRoute;
  chatJid: string;
  threadId: string | null;
  cause?: 'new-session' | 'manual-compact';
  defaultScope?: MemoryBoundaryDefaultScope;
  memoryUserId?: string;
  collectMemory?: SessionMemoryCollector;
  executionProviderId?: import('../domain/sessions/sessions.js').ExecutionProviderId;
}): Promise<void> {
  const turnContext = await input.ops.getAgentTurnContext?.({
    appId: input.appId,
    agentFolder: input.group.folder,
    executionProviderId:
      input.executionProviderId ?? resolveRuntimeExecutionProviderId(),
    conversationJid: input.chatJid,
    threadId: input.threadId,
    conversationKind: input.group.conversationKind,
    memoryUserId: input.memoryUserId,
    hydrateMemory: false,
  });
  const collectMemory = input.collectMemory;
  if (turnContext?.agentSessionId && collectMemory) {
    const trigger =
      input.cause === 'manual-compact' ? 'precompact' : 'session-end';
    try {
      const result = await collectMemory({
        agentSessionId: turnContext.agentSessionId,
        trigger,
        ...(input.defaultScope ? { defaultScope: input.defaultScope } : {}),
      });
      logger.info(
        {
          group: input.group.name,
          agentSessionId: turnContext.agentSessionId,
          trigger,
          saved: result?.saved ?? 0,
        },
        'Collected durable memory at session boundary',
      );
    } catch (err) {
      logger.warn(
        { group: input.group.name, err, trigger },
        'Failed to collect durable memory at session boundary',
      );
    }
  }
  logger.info(
    { group: input.group.name, agentSessionId: turnContext?.agentSessionId },
    'Archived Gantry session boundary memory; provider transcripts are not runtime state',
  );
}

export function buildRuntimeRunOptions(input: {
  timeoutMs?: number;
  signal?: AbortSignal;
  credentialBroker?: RunAgentOptions['credentialBroker'];
  skillRepository?: SkillCatalogRepository;
  skillArtifactStore?: SkillArtifactStore;
  mcpServerRepository?: McpServerRepository;
  capabilitySecretRepository?: CapabilitySecretRepository;
  mcpHostnameLookup?: HostnameLookup;
  mcpDnsValidationCache?: RemoteMcpDnsValidationCache;
  publishRuntimeEvent?: RunAgentOptions['publishRuntimeEvent'];
  executionAdapter?: RunAgentOptions['executionAdapter'];
  executionAdapters?: RunAgentOptions['executionAdapters'];
  runnerSandboxProvider: RunAgentOptions['runnerSandboxProvider'];
  skillContext?: {
    appId: string;
    agentId: string;
  };
  turnContext?: {
    appId: string;
    agentId: string;
    agentSessionId: string;
    externalSessionId?: string;
  };
}): RunAgentOptions {
  const resolvedSkillContext = input.skillContext
    ? input.skillContext
    : input.turnContext
      ? {
          appId: input.turnContext.appId,
          agentId: input.turnContext.agentId,
        }
      : undefined;
  const skillOptions =
    input.skillRepository && input.skillArtifactStore && resolvedSkillContext
      ? {
          skillRepository: input.skillRepository,
          skillArtifactStore: input.skillArtifactStore,
          skillContext: resolvedSkillContext,
        }
      : {};
  const mcpOptions =
    input.mcpServerRepository &&
    input.capabilitySecretRepository &&
    resolvedSkillContext
      ? {
          mcpServerRepository: input.mcpServerRepository,
          capabilitySecretRepository: input.capabilitySecretRepository,
          mcpContext: resolvedSkillContext,
          mcpHostnameLookup: input.mcpHostnameLookup,
          mcpDnsValidationCache: input.mcpDnsValidationCache,
        }
      : {};
  const options: RunAgentOptions = {
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.credentialBroker
      ? { credentialBroker: input.credentialBroker }
      : {}),
    ...(input.capabilitySecretRepository
      ? { capabilitySecretRepository: input.capabilitySecretRepository }
      : {}),
    ...skillOptions,
    ...mcpOptions,
    ...(input.publishRuntimeEvent
      ? { publishRuntimeEvent: input.publishRuntimeEvent }
      : {}),
    ...(input.executionAdapter
      ? { executionAdapter: input.executionAdapter }
      : {}),
    ...(input.executionAdapters
      ? { executionAdapters: input.executionAdapters }
      : {}),
    runnerSandboxProvider: input.runnerSandboxProvider,
  };
  return options;
}

export async function completeSuccessfulRuntimeSessionRun(input: {
  ops: RuntimeAgentSessionRepository;
  group: ConversationRoute;
  chatJid?: string;
  threadId?: string | null;
  conversationKind?: 'dm' | 'channel';
  memoryUserId?: string;
  jobId?: string;
  agentSessionId?: string;
  agentSessionResetAt?: string | null;
  providerSessionId?: string;
  runId?: string;
  result?: string | null;
}): Promise<void> {
  if (input.runId) {
    try {
      await input.ops.completeSessionAgentRun?.({
        runId: input.runId,
        status: 'completed',
        resultSummary: summarizeRuntimeResultForPersistence(input.result),
      });
    } catch (err) {
      logger.warn(
        { err, runId: input.runId },
        'Failed to complete runtime session run; continuing with outer run finalization',
      );
    }
  }
  if (input.agentSessionId) {
    logger.debug(
      {
        group: input.group.name,
        agentSessionId: input.agentSessionId,
        providerSessionId: input.providerSessionId,
      },
      'Completed runtime session run',
    );
  }
}

export async function completeFailedRuntimeSessionRun(input: {
  ops: RuntimeAgentSessionRepository;
  runId?: string;
  errorSummary: string;
}): Promise<void> {
  if (!input.runId) return;
  try {
    await input.ops.completeSessionAgentRun?.({
      runId: input.runId,
      status: 'failed',
      // Error summaries can carry secrets (gateway tokens, API keys, URLs with
      // credentials) lifted from upstream error bodies; run the full secret
      // redaction before the provider-session redaction + truncation so nothing
      // sensitive is persisted on the failed-run record.
      errorSummary: summarizeRuntimeResultForPersistence(
        redactString(input.errorSummary),
      ),
    });
  } catch (err) {
    logger.warn(
      { err, runId: input.runId },
      'Failed to complete runtime session run; continuing with outer run finalization',
    );
  }
}

export async function failRuntimeSessionRun(
  ops: RuntimeAgentSessionRepository,
  runId: string | undefined,
  errorSummary: string | null,
): Promise<void> {
  await completeFailedRuntimeSessionRun({
    ops,
    runId,
    errorSummary: errorSummary ?? 'Unknown error',
  });
}

export async function buildApprovedSkillContextBlock(input: {
  skillRepository?: SkillCatalogRepository;
  skillArtifactStore?: SkillArtifactStore;
  turnContext?: {
    appId: string;
    agentId: string;
  };
}): Promise<string> {
  if (!input.skillRepository || !input.turnContext) {
    return '';
  }
  const skills = await input.skillRepository.listEnabledSkillsForAgent({
    appId: input.turnContext.appId as never,
    agentId: input.turnContext.agentId as never,
  });
  if (skills.length === 0) return '';
  const sections: string[] = [
    '[[INSTALLED_SKILLS_AVAILABLE_THIS_SESSION]]',
    'The following reviewed Gantry skills are available to use in this session. This block intentionally contains only skill metadata so provider-native skill loading can use progressive disclosure. Do not claim these skills are unavailable solely because the provider session was already running.',
  ];
  for (const skill of skills) {
    sections.push(
      [
        '',
        `## ${selectedSkillDisplay(skill)}`,
        `id: ${skill.id}`,
        `name: ${skill.name}`,
        `source: ${skill.source}`,
        skill.storage?.contentHash
          ? `revision: ${skill.storage.contentHash}`
          : undefined,
        skill.description ? `description: ${skill.description}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    );
  }
  sections.push(
    'Full SKILL.md instructions and supporting files are read only through the selected provider or DeepAgents skill mechanism after the skill matches the task and the run has authority.',
  );
  sections.push('[[/APPROVED_SKILLS_AVAILABLE_THIS_SESSION]]');
  return sections.length > 3 ? sections.join('\n') : '';
}

export function resolveMemoryUserId(
  messages: NewMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.is_from_me) continue;
    const sender = message.sender?.trim();
    if (sender) return sender;
  }
  return messages[messages.length - 1]?.sender?.trim() || undefined;
}

export function resolveNonSelfSenderIds(
  messages: readonly { sender?: string | null; is_from_me?: boolean | null }[],
): string[] {
  const senderIds = new Set<string>();
  for (const message of messages) {
    if (message.is_from_me) continue;
    const sender = message.sender?.trim();
    if (sender) senderIds.add(sender);
  }
  return [...senderIds];
}

export function resolveSingleNonSelfSenderId(
  messages: readonly { sender?: string | null; is_from_me?: boolean | null }[],
): string | undefined {
  const senderIds = resolveNonSelfSenderIds(messages);
  return senderIds.length === 1 ? senderIds[0] : undefined;
}
