import type { NewMessage, RegisteredGroup } from '../domain/types.js';
import type { OpsRepository } from '../domain/repositories/ops-repo.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type {
  McpServerRepository,
  SkillCatalogRepository,
} from '../domain/ports/repositories.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { RunAgentOptions } from './agent-spawn-types.js';
import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';

export async function archiveCurrentRuntimeSession(input: {
  ops: OpsRepository;
  group: RegisteredGroup;
  chatJid: string;
  threadId: string | null;
  cause?: 'new-session' | 'manual-compact';
  collectMemory?: SessionMemoryCollector;
}): Promise<void> {
  const turnContext = await input.ops.getAgentTurnContext?.({
    groupFolder: input.group.folder,
    chatJid: input.chatJid,
    threadId: input.threadId,
  });
  const collectMemory = input.collectMemory;
  if (turnContext?.agentSessionId && collectMemory) {
    const trigger =
      input.cause === 'manual-compact' ? 'precompact' : 'session-end';
    try {
      const result = await collectMemory({
        agentSessionId: turnContext.agentSessionId,
        trigger,
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
  ops: OpsRepository;
  group: RegisteredGroup;
  agentSessionId?: string;
  runId?: string;
  result?: string | null;
}): Promise<void> {
  if (input.runId) {
    await input.ops.completeSessionAgentRun?.({
      runId: input.runId,
      status: 'completed',
      resultSummary: input.result ?? null,
    });
  }
  if (input.agentSessionId) {
    logger.debug(
      { group: input.group.name, agentSessionId: input.agentSessionId },
      'Completed runtime session run without Postgres prompt replay',
    );
  }
}

export async function completeFailedRuntimeSessionRun(input: {
  ops: OpsRepository;
  runId?: string;
  errorSummary: string;
}): Promise<void> {
  if (!input.runId) return;
  await input.ops.completeSessionAgentRun?.({
    runId: input.runId,
    status: 'failed',
    errorSummary: input.errorSummary,
  });
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
