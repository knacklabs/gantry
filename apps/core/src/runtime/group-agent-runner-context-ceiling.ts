import type { AgentOutput } from './agent-spawn.js';
import type {
  GroupProcessingDeps,
  GroupProcessingRepository,
} from './group-processing-types.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { RetiredProviderSessionReference } from '../domain/sessions/provider-session-measurement.js';
import {
  hashProviderSessionExternalId,
  publishProviderSessionRuntimeEvent,
} from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { modelVisibleInputTokens } from '../shared/model-usage.js';
import { logger, redactString } from '../infrastructure/logging/logger.js';
import { providerSessionAccessFingerprintMatches } from './provider-session-access-fingerprint.js';
import { getConfiguredProviderSessionMaxInputTokens } from './agent-spawn-host.js';
import { prepareCompactionDeltaReplay } from './group-agent-runner-compaction-delta.js';
import type { ProviderSessionContinuity } from '../domain/repositories/ops-repo.js';

type AgentTurnContext = Awaited<
  ReturnType<NonNullable<GroupProcessingRepository['getAgentTurnContext']>>
>;
type LoadTurnContext = (
  promoteReadyProviderSession: boolean,
  hydrateMemory?: boolean,
) => Promise<AgentTurnContext | undefined>;
type ProviderSessionPolicyDeps = {
  currentAccessFingerprint: string;
  repository: GroupProcessingRepository;
  executionProviderId: ExecutionProviderId;
  publish: GroupProcessingDeps['publishRuntimeEvent'];
  appId: string;
  groupName: string;
  loadTurnContext: LoadTurnContext;
  onRetired: (reference: RetiredProviderSessionReference) => void;
};

export async function retireSelectedProviderSession(input: {
  repository: GroupProcessingRepository;
  turnContext: AgentTurnContext;
  executionProviderId: ExecutionProviderId;
}): Promise<RetiredProviderSessionReference | undefined> {
  if (
    !input.turnContext.providerSessionId ||
    !input.turnContext.externalSessionId
  ) {
    return undefined;
  }
  return input.repository.retireProviderSession({
    providerSessionId: input.turnContext.providerSessionId,
    agentSessionId: input.turnContext.agentSessionId,
    provider: input.executionProviderId,
    externalSessionId: input.turnContext.externalSessionId,
    expectedAgentSessionResetAt: input.turnContext.agentSessionResetAt ?? null,
  });
}

export async function raiseProviderSessionMarkFromOutput(input: {
  output: AgentOutput;
  repository: GroupProcessingRepository;
  turnContext: AgentTurnContext | undefined;
  executionProviderId: ExecutionProviderId;
  providerSessionId: string | undefined;
  externalSessionId: string | undefined;
}): Promise<void> {
  const contextHighWaterMark =
    input.output.contextUsage?.totalTokens ??
    (input.output.usage
      ? modelVisibleInputTokens(input.output.usage)
      : undefined);
  if (
    contextHighWaterMark === undefined ||
    !input.providerSessionId ||
    !input.externalSessionId ||
    !input.turnContext?.agentSessionId ||
    !input.repository.raiseProviderSessionContextHighWaterMark
  ) {
    return;
  }
  await input.repository.raiseProviderSessionContextHighWaterMark({
    providerSessionId: input.providerSessionId,
    agentSessionId: input.turnContext.agentSessionId,
    provider: input.executionProviderId,
    externalSessionId: input.externalSessionId,
    expectedAgentSessionResetAt: input.turnContext.agentSessionResetAt ?? null,
    contextHighWaterMark,
  });
}

type RetirementPublication =
  | {
      reason: 'ceiling';
      reference: RetiredProviderSessionReference;
      contextHighWaterMark: number;
      cap: number;
    }
  | {
      reason: 'fingerprint' | 'missing';
      reference: RetiredProviderSessionReference;
      runId?: string;
    };

export async function publishProviderSessionRetirement(input: {
  publish: GroupProcessingDeps['publishRuntimeEvent'];
  appId: string;
  agentId?: string;
  sessionId?: string;
  groupName: string;
  retirement: RetirementPublication;
}): Promise<void> {
  try {
    await publishProviderSessionRuntimeEvent(input.publish, {
      appId: input.appId as never,
      agentId: input.agentId as never,
      sessionId: input.sessionId as never,
      ...(input.retirement.reason === 'missing' && input.retirement.runId
        ? { runId: input.retirement.runId as never }
        : {}),
      eventType: RUNTIME_EVENT_TYPES.SESSION_PROVIDER_RETIRED,
      payload:
        input.retirement.reason === 'ceiling'
          ? {
              reason: 'ceiling',
              providerSessionHash: hashProviderSessionExternalId(
                input.retirement.reference.externalSessionId,
              ),
              executionProviderId:
                input.retirement.reference.executionProviderId,
              contextHighWaterMark: input.retirement.contextHighWaterMark,
              cap: input.retirement.cap,
            }
          : {
              reason: input.retirement.reason,
              providerSessionHash: hashProviderSessionExternalId(
                input.retirement.reference.externalSessionId,
              ),
              executionProviderId:
                input.retirement.reference.executionProviderId,
            },
    });
  } catch (err) {
    logger.warn(
      {
        err,
        group: input.groupName,
        reason: input.retirement.reason,
      },
      'Failed to publish provider session retirement event',
    );
  }
}

type ProviderSessionRetirement =
  | (Omit<
      Extract<RetirementPublication, { reason: 'ceiling' }>,
      'reference'
    > & { turnContext: AgentTurnContext })
  | (Omit<
      Extract<RetirementPublication, { reason: 'fingerprint' | 'missing' }>,
      'reference'
    > & { turnContext: AgentTurnContext });

export async function retireProviderSessionWithEvent(input: {
  repository: GroupProcessingRepository;
  executionProviderId: ExecutionProviderId;
  publish: GroupProcessingDeps['publishRuntimeEvent'];
  appId: string;
  groupName: string;
  retirement: ProviderSessionRetirement;
  onRetired: (reference: RetiredProviderSessionReference) => void;
}): Promise<RetiredProviderSessionReference | undefined> {
  const reference = await retireSelectedProviderSession({
    repository: input.repository,
    turnContext: input.retirement.turnContext,
    executionProviderId: input.executionProviderId,
  });
  if (!reference) return undefined;
  input.onRetired(reference);
  const retirement: RetirementPublication =
    input.retirement.reason === 'ceiling'
      ? {
          reason: 'ceiling',
          reference,
          contextHighWaterMark: input.retirement.contextHighWaterMark,
          cap: input.retirement.cap,
        }
      : {
          reason: input.retirement.reason,
          reference,
          runId: input.retirement.runId,
        };
  await publishProviderSessionRetirement({
    publish: input.publish,
    appId: input.appId,
    agentId: input.retirement.turnContext.agentId,
    sessionId: input.retirement.turnContext.agentSessionId,
    groupName: input.groupName,
    retirement,
  });
  return reference;
}

export async function retireMissingProviderSession(input: {
  reason: string;
  repository: GroupProcessingRepository;
  turnContext: AgentTurnContext | undefined;
  executionProviderId: ExecutionProviderId;
  publish: GroupProcessingDeps['publishRuntimeEvent'];
  appId: string;
  groupName: string;
  runId?: string;
  onRetired: (reference: RetiredProviderSessionReference) => void;
  clearRunProviderSession: () => Promise<void>;
}): Promise<boolean> {
  if (
    !input.turnContext?.providerSessionId ||
    !input.turnContext.agentSessionId ||
    !input.turnContext.externalSessionId
  ) {
    return false;
  }
  await retireProviderSessionWithEvent({
    repository: input.repository,
    executionProviderId: input.executionProviderId,
    publish: input.publish,
    appId: input.appId,
    groupName: input.groupName,
    retirement: {
      reason: 'missing',
      turnContext: input.turnContext,
      runId: input.runId,
    },
    onRetired: input.onRetired,
  });
  await input.clearRunProviderSession();
  logger.warn(
    { group: input.groupName, reason: redactString(input.reason) },
    'Expired stale provider session and retrying without resume',
  );
  return true;
}

export interface ProviderSessionCeilingPreflightResult {
  turnContext: AgentTurnContext | undefined;
  latestProviderSessionId: string | undefined;
  currentProviderSessionId: string | undefined;
  resumeProviderSessionId: string | undefined;
  resumeExternalSessionId: string | undefined;
  providerSessionPersistenceAllowed: boolean;
}

async function recoverLostProviderSessionRetirement(input: {
  turnContext: AgentTurnContext;
  restoreResumeIdentifiers: boolean;
  currentAccessFingerprint: string;
  cap: number;
  loadTurnContext: LoadTurnContext;
}): Promise<ProviderSessionCeilingPreflightResult> {
  const refreshed = await input.loadTurnContext(false, false);
  const nextContext =
    refreshed &&
    refreshed.agentSessionId === input.turnContext.agentSessionId &&
    (refreshed.agentSessionResetAt ?? null) ===
      (input.turnContext.agentSessionResetAt ?? null)
      ? {
          ...refreshed,
          memoryContextBlock: input.turnContext.memoryContextBlock,
        }
      : await input.loadTurnContext(false, true);
  const resumeIdentifiersEligible =
    input.restoreResumeIdentifiers &&
    Boolean(nextContext?.providerSessionId) &&
    Boolean(nextContext?.externalSessionId) &&
    providerSessionAccessFingerprintMatches(
      nextContext?.providerSessionAccessFingerprint,
      input.currentAccessFingerprint,
    ) &&
    (typeof nextContext?.contextHighWaterMark !== 'number' ||
      nextContext.contextHighWaterMark <= input.cap);
  return {
    turnContext: nextContext,
    latestProviderSessionId: resumeIdentifiersEligible
      ? nextContext?.externalSessionId?.trim()
      : undefined,
    currentProviderSessionId: resumeIdentifiersEligible
      ? nextContext?.providerSessionId
      : undefined,
    resumeProviderSessionId: resumeIdentifiersEligible
      ? nextContext?.providerSessionId
      : undefined,
    resumeExternalSessionId: resumeIdentifiersEligible
      ? nextContext?.externalSessionId
      : undefined,
    providerSessionPersistenceAllowed: false,
  };
}

export async function prepareProviderSessionContext(
  input: Omit<
    ProviderSessionCeilingPreflightResult,
    'providerSessionPersistenceAllowed'
  > &
    ProviderSessionPolicyDeps & { maintenanceProviderSession: boolean },
): Promise<ProviderSessionCeilingPreflightResult> {
  const { turnContext } = input;
  const cap = getConfiguredProviderSessionMaxInputTokens();
  if (
    turnContext?.providerSessionId &&
    turnContext.externalSessionId &&
    !providerSessionAccessFingerprintMatches(
      turnContext.providerSessionAccessFingerprint,
      input.currentAccessFingerprint,
    )
  ) {
    const retired = await retireProviderSessionWithEvent({
      repository: input.repository,
      executionProviderId: input.executionProviderId,
      publish: input.publish,
      appId: input.appId,
      groupName: input.groupName,
      retirement: { reason: 'fingerprint', turnContext },
      onRetired: input.onRetired,
    });
    if (!retired) {
      return recoverLostProviderSessionRetirement({
        turnContext,
        restoreResumeIdentifiers: false,
        currentAccessFingerprint: input.currentAccessFingerprint,
        cap,
        loadTurnContext: input.loadTurnContext,
      });
    }
    logger.warn(
      {
        group: input.groupName,
        agentId: turnContext.agentId,
        agentSessionId: turnContext.agentSessionId,
      },
      'Expired provider session because runtime access projection changed',
    );
    return {
      turnContext,
      latestProviderSessionId: undefined,
      currentProviderSessionId: undefined,
      resumeProviderSessionId: undefined,
      resumeExternalSessionId: undefined,
      providerSessionPersistenceAllowed: true,
    };
  }

  return (
    (await applyProviderSessionCeilingPreflight({
      turnContext,
      cap,
      currentAccessFingerprint: input.currentAccessFingerprint,
      maintenanceProviderSession: input.maintenanceProviderSession,
      repository: input.repository,
      executionProviderId: input.executionProviderId,
      publish: input.publish,
      appId: input.appId,
      groupName: input.groupName,
      loadTurnContext: input.loadTurnContext,
      onRetired: input.onRetired,
    })) ?? {
      turnContext,
      latestProviderSessionId: input.latestProviderSessionId,
      currentProviderSessionId: input.currentProviderSessionId,
      resumeProviderSessionId: input.resumeProviderSessionId,
      resumeExternalSessionId: input.resumeExternalSessionId,
      providerSessionPersistenceAllowed: true,
    }
  );
}

export async function prepareProviderSessionFailoverAttempt(
  input: ProviderSessionPolicyDeps & {
    previousContext: AgentTurnContext | undefined;
    previousExecutionProviderId: ExecutionProviderId;
    providerSessionContinuity: ProviderSessionContinuity;
    maintenanceProviderSession?: {
      providerSessionId: string;
      externalSessionId: string;
    };
    group: Parameters<typeof prepareCompactionDeltaReplay>[0]['group'];
    chatJid: string;
    threadId: string | null;
    patternsContextBlock: string;
    approvedSkillContextBlock: string;
    updateRunProviderMetadata(
      input: {
        providerRunId?: string | null;
        providerSessionId: string | null;
      },
      required?: boolean,
    ): Promise<void>;
  },
): Promise<{
  turnContext: AgentTurnContext | undefined;
  latestProviderSessionId: string | undefined;
  currentProviderSessionId: string | undefined;
  resumeProviderSessionId: string | undefined;
  resumeExternalSessionId: string | undefined;
  providerSessionPersistenceAllowed: boolean;
  memoryContextBlock: string;
}> {
  if (
    input.maintenanceProviderSession &&
    (input.providerSessionContinuity !== 'durable_resume' ||
      input.previousExecutionProviderId !== input.executionProviderId)
  ) {
    throw new Error(
      'Provider-session maintenance cannot fail over across execution providers',
    );
  }
  const refreshed = await input.loadTurnContext(false, false);
  const sameGeneration =
    refreshed &&
    refreshed.agentSessionId === input.previousContext?.agentSessionId &&
    (refreshed.agentSessionResetAt ?? null) ===
      (input.previousContext?.agentSessionResetAt ?? null);
  const selectedContext = sameGeneration
    ? {
        ...refreshed,
        memoryContextBlock: input.previousContext?.memoryContextBlock,
      }
    : await input.loadTurnContext(false, true);
  const replay = await prepareCompactionDeltaReplay({
    turnContext: selectedContext,
    loadTurnContext: input.loadTurnContext,
    repository: input.repository,
    executionProviderId: input.executionProviderId,
    group: input.group,
    chatJid: input.chatJid,
    threadId: input.threadId,
    maintenanceProviderSession: input.maintenanceProviderSession,
  });
  let turnContext = replay.turnContext;
  let latestProviderSessionId =
    input.maintenanceProviderSession?.externalSessionId.trim() ||
    turnContext?.externalSessionId?.trim();
  let currentProviderSessionId =
    input.maintenanceProviderSession?.providerSessionId ??
    turnContext?.providerSessionId;
  let resumeProviderSessionId = currentProviderSessionId;
  let resumeExternalSessionId =
    input.maintenanceProviderSession?.externalSessionId ??
    turnContext?.externalSessionId;
  let providerSessionPersistenceAllowed =
    input.providerSessionContinuity === 'durable_resume';
  if (providerSessionPersistenceAllowed) {
    ({
      turnContext,
      latestProviderSessionId,
      currentProviderSessionId,
      resumeProviderSessionId,
      resumeExternalSessionId,
      providerSessionPersistenceAllowed,
    } = await prepareProviderSessionContext({
      turnContext,
      latestProviderSessionId,
      currentProviderSessionId,
      resumeProviderSessionId,
      resumeExternalSessionId,
      maintenanceProviderSession: Boolean(input.maintenanceProviderSession),
      currentAccessFingerprint: input.currentAccessFingerprint,
      repository: input.repository,
      executionProviderId: input.executionProviderId,
      publish: input.publish,
      appId: input.appId,
      groupName: input.groupName,
      loadTurnContext: input.loadTurnContext,
      onRetired: input.onRetired,
    }));
    await input.updateRunProviderMetadata({
      providerSessionId: resumeProviderSessionId ?? null,
    });
  } else {
    latestProviderSessionId = undefined;
    currentProviderSessionId = undefined;
    resumeProviderSessionId = undefined;
    resumeExternalSessionId = undefined;
    await input.updateRunProviderMetadata(
      { providerRunId: null, providerSessionId: null },
      true,
    );
  }
  return {
    turnContext,
    latestProviderSessionId,
    currentProviderSessionId,
    resumeProviderSessionId,
    resumeExternalSessionId,
    providerSessionPersistenceAllowed,
    memoryContextBlock: [
      replay.block,
      turnContext?.memoryContextBlock,
      input.patternsContextBlock,
      input.approvedSkillContextBlock,
    ]
      .filter((block): block is string => Boolean(block?.trim()))
      .join('\n\n'),
  };
}

export function createRunProviderMetadataUpdater(input: {
  repository(): GroupProcessingRepository;
  runId(): string | undefined;
  lease?: {
    leaseToken: string;
    workerInstanceId?: string;
    fencingVersion?: number;
  };
  groupName: string;
}): {
  update(
    metadata: {
      providerRunId?: string | null;
      providerSessionId?: string | null;
    },
    required?: boolean,
  ): Promise<void>;
  trackProviderRun(providerRunId: string): void;
} {
  let pendingProviderRunLink: Promise<void> | undefined;
  const update = async (
    metadata: {
      providerRunId?: string | null;
      providerSessionId?: string | null;
    },
    required = false,
  ): Promise<void> => {
    if (required) await pendingProviderRunLink;
    const runId = input.runId();
    if (!runId) return;
    const repository = input.repository();
    if (!repository.updateAgentRunProviderMetadata) {
      if (required) {
        throw new Error('Run provider metadata repository is unavailable');
      }
      return;
    }
    const write = repository.updateAgentRunProviderMetadata({
      runId,
      ...metadata,
      ...input.lease,
    });
    if (required) {
      await write;
    } else {
      await write.catch((err) => {
        logger.warn(
          { err, group: input.groupName, runId },
          'Failed to update runtime run provider metadata',
        );
      });
    }
  };
  return {
    update,
    trackProviderRun(providerRunId) {
      const write = update({ providerRunId });
      pendingProviderRunLink = write;
      void write.then(() => {
        if (pendingProviderRunLink === write)
          pendingProviderRunLink = undefined;
      });
    },
  };
}

export async function persistDurableProviderSessionFromOutput(input: {
  output: AgentOutput;
  persistenceAllowed: boolean;
  latestProviderSessionId: string | undefined;
  turnContext: AgentTurnContext | undefined;
  maintenanceProviderSession: boolean;
  repository: GroupProcessingRepository;
  agentFolder: string;
  threadId: string | null;
  appId: string;
  executionProviderId: ExecutionProviderId;
  conversationJid: string;
  providerAccountId?: string;
  conversationKind?: 'dm' | 'channel';
  memoryUserId?: string;
  accessFingerprint: string;
  updateRunProviderMetadata(sessionId: string): Promise<void>;
}): Promise<string | undefined> {
  if (
    input.output.status === 'error' ||
    input.turnContext?.latestProviderSessionLocked ||
    input.maintenanceProviderSession
  ) {
    return undefined;
  }
  const nextSessionId = (
    input.output.providerSession?.externalSessionId ?? input.output.newSessionId
  )?.trim();
  if (
    !input.persistenceAllowed ||
    !nextSessionId ||
    nextSessionId === input.latestProviderSessionId ||
    !input.turnContext?.agentSessionId ||
    !input.repository.setSession
  ) {
    return undefined;
  }
  const persisted = await input.repository.setSession(
    input.agentFolder,
    nextSessionId,
    input.threadId,
    {
      appId: input.appId,
      executionProviderId: input.executionProviderId,
      conversationJid: input.conversationJid,
      providerAccountId: input.providerAccountId,
      conversationKind: input.conversationKind,
      memoryUserId: input.memoryUserId,
      expectedAgentSessionId: input.turnContext.agentSessionId,
      expectedAgentSessionResetAt:
        input.turnContext.agentSessionResetAt ?? null,
      accessFingerprint: input.accessFingerprint,
    },
  );
  if (persisted === false) {
    logger.warn(
      { group: input.agentFolder },
      'Provider session update skipped because turn ownership changed',
    );
    return undefined;
  }
  await input.updateRunProviderMetadata(nextSessionId);
  return nextSessionId;
}

export async function applyProviderSessionCeilingPreflight(
  input: ProviderSessionPolicyDeps & {
    turnContext: AgentTurnContext | undefined;
    cap: number;
    maintenanceProviderSession: boolean;
  },
): Promise<ProviderSessionCeilingPreflightResult | undefined> {
  const { turnContext } = input;
  if (
    !turnContext?.providerSessionId ||
    !turnContext.externalSessionId ||
    turnContext.latestProviderSessionLocked ||
    input.maintenanceProviderSession ||
    typeof turnContext.contextHighWaterMark !== 'number' ||
    turnContext.contextHighWaterMark <= input.cap
  ) {
    return undefined;
  }
  const retired = await retireProviderSessionWithEvent({
    repository: input.repository,
    executionProviderId: input.executionProviderId,
    publish: input.publish,
    appId: input.appId,
    groupName: input.groupName,
    onRetired: input.onRetired,
    retirement: {
      reason: 'ceiling',
      turnContext,
      contextHighWaterMark: turnContext.contextHighWaterMark,
      cap: input.cap,
    },
  });
  if (retired) {
    return {
      turnContext,
      latestProviderSessionId: undefined,
      currentProviderSessionId: undefined,
      resumeProviderSessionId: undefined,
      resumeExternalSessionId: undefined,
      providerSessionPersistenceAllowed: true,
    };
  }

  return recoverLostProviderSessionRetirement({
    turnContext,
    restoreResumeIdentifiers: true,
    currentAccessFingerprint: input.currentAccessFingerprint,
    cap: input.cap,
    loadTurnContext: input.loadTurnContext,
  });
}
