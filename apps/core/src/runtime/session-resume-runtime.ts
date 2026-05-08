import type { NewMessage, ConversationRoute } from '../domain/types.js';
import type { RuntimeAgentSessionRepository } from '../domain/repositories/ops-repo.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type {
  McpServerRepository,
  SkillCatalogRepository,
} from '../domain/ports/repositories.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { RunAgentOptions } from './agent-spawn-types.js';
import type {
  MemoryBoundaryDefaultScope,
  SessionMemoryCollector,
} from '../domain/ports/session-memory-collector.js';
import { redactProviderSessionHandlesInText } from '../shared/provider-session-redaction.js';

export const RUNTIME_RESULT_SUMMARY_MAX_CHARS = 4_000;

const RUNTIME_RESULT_SUMMARY_TRUNCATION_PREFIX =
  '[output truncated; showing tail]\n';

function truncateRuntimeResultSummary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return '';
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

export async function archiveCurrentRuntimeSession(input: {
  ops: RuntimeAgentSessionRepository;
  group: ConversationRoute;
  chatJid: string;
  threadId: string | null;
  cause?: 'new-session' | 'manual-compact';
  defaultScope?: MemoryBoundaryDefaultScope;
  memoryUserId?: string;
  collectMemory?: SessionMemoryCollector;
}): Promise<void> {
  const turnContext = await input.ops.getAgentTurnContext?.({
    agentFolder: input.group.folder,
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
    'Archived MyClaw session boundary memory; provider transcripts are not runtime state',
  );
}

export function buildRuntimeRunOptions(input: {
  timeoutMs?: number;
  credentialBroker?: RunAgentOptions['credentialBroker'];
  skillRepository?: SkillCatalogRepository;
  skillArtifactStore?: SkillArtifactStore;
  mcpServerRepository?: McpServerRepository;
  mcpHostnameLookup?: HostnameLookup;
  mcpDnsValidationCache?: RemoteMcpDnsValidationCache;
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
}): RunAgentOptions | undefined {
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
    input.mcpServerRepository && resolvedSkillContext
      ? {
          mcpServerRepository: input.mcpServerRepository,
          mcpContext: resolvedSkillContext,
          mcpHostnameLookup: input.mcpHostnameLookup,
          mcpDnsValidationCache: input.mcpDnsValidationCache,
        }
      : {};
  const options: RunAgentOptions = {
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.credentialBroker
      ? { credentialBroker: input.credentialBroker }
      : {}),
    ...skillOptions,
    ...mcpOptions,
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

export async function completeSuccessfulRuntimeSessionRun(input: {
  ops: RuntimeAgentSessionRepository;
  group: ConversationRoute;
  chatJid?: string;
  threadId?: string | null;
  conversationKind?: 'dm' | 'channel';
  memoryUserId?: string;
  agentSessionId?: string;
  providerSessionId?: string;
  runId?: string;
  result?: string | null;
}): Promise<void> {
  if (input.runId) {
    await input.ops.completeSessionAgentRun?.({
      runId: input.runId,
      status: 'completed',
      resultSummary: summarizeRuntimeResultForPersistence(input.result),
    });
  }
  if (input.agentSessionId) {
    if (input.providerSessionId && input.chatJid) {
      await input.ops.setSession(
        input.group.folder,
        input.providerSessionId,
        input.threadId,
        {
          conversationJid: input.chatJid,
          conversationKind: input.conversationKind,
          memoryUserId: input.memoryUserId,
        },
      );
    }
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
  await input.ops.completeSessionAgentRun?.({
    runId: input.runId,
    status: 'failed',
    errorSummary: summarizeRuntimeResultForPersistence(input.errorSummary),
  });
}

export async function buildApprovedSkillContextBlock(input: {
  skillRepository?: SkillCatalogRepository;
  skillArtifactStore?: SkillArtifactStore;
  turnContext?: {
    appId: string;
    agentId: string;
  };
  maxChars?: number;
}): Promise<string> {
  if (
    !input.skillRepository ||
    !input.skillArtifactStore ||
    !input.turnContext
  ) {
    return '';
  }
  const maxChars = input.maxChars ?? 16_000;
  const skills = await input.skillRepository.listEnabledSkillsForAgent({
    appId: input.turnContext.appId as never,
    agentId: input.turnContext.agentId as never,
  });
  if (skills.length === 0) return '';
  const sections: string[] = [
    '[[APPROVED_SKILLS_AVAILABLE_THIS_SESSION]]',
    'The following MyClaw-approved skills are available to use in this session. Follow the SKILL.md instructions when relevant. Do not claim these skills are unavailable solely because the provider session was already running.',
  ];
  let remaining = maxChars - sections.join('\n').length;
  for (const skill of skills) {
    if (!skill.storage || remaining <= 0) break;
    const bundle = await input.skillArtifactStore.getSkillArtifact(
      skill.storage.storageRef,
    );
    const skillMarkdown = bundle.assets.find(
      (asset) => asset.path === 'SKILL.md',
    );
    if (!skillMarkdown) continue;
    const content = Buffer.from(skillMarkdown.content).toString('utf-8');
    const rendered = [
      '',
      `## ${skill.name}`,
      `id: ${skill.id}`,
      skill.description ? `description: ${skill.description}` : undefined,
      `contentHash: ${skill.storage.contentHash}`,
      '',
      '```markdown',
      content,
      '```',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
    const chunk =
      rendered.length <= remaining
        ? rendered
        : `${rendered.slice(0, Math.max(0, remaining - 80)).trimEnd()}\n[Skill context truncated]`;
    sections.push(chunk);
    remaining -= chunk.length;
  }
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
