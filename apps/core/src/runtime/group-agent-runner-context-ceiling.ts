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

type AgentTurnContext = Awaited<
  ReturnType<NonNullable<GroupProcessingRepository['getAgentTurnContext']>>
>;

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
  loadTurnContext: (
    promoteReadyProviderSession: boolean,
    hydrateMemory?: boolean,
  ) => Promise<AgentTurnContext | undefined>;
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
  return {
    turnContext: nextContext,
    latestProviderSessionId: nextContext?.externalSessionId?.trim(),
    currentProviderSessionId: nextContext?.providerSessionId,
    resumeProviderSessionId: nextContext?.providerSessionId,
    resumeExternalSessionId: nextContext?.externalSessionId,
    providerSessionPersistenceAllowed: false,
  };
}

export async function prepareProviderSessionContext(input: {
  turnContext: AgentTurnContext | undefined;
  latestProviderSessionId: string | undefined;
  currentProviderSessionId: string | undefined;
  resumeProviderSessionId: string | undefined;
  resumeExternalSessionId: string | undefined;
  maintenanceProviderSession: boolean;
  currentAccessFingerprint: string;
  repository: GroupProcessingRepository;
  executionProviderId: ExecutionProviderId;
  publish: GroupProcessingDeps['publishRuntimeEvent'];
  appId: string;
  groupName: string;
  loadTurnContext: (
    promoteReadyProviderSession: boolean,
    hydrateMemory?: boolean,
  ) => Promise<AgentTurnContext | undefined>;
  onRetired: (reference: RetiredProviderSessionReference) => void;
}): Promise<ProviderSessionCeilingPreflightResult> {
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

export async function applyProviderSessionCeilingPreflight(input: {
  turnContext: AgentTurnContext | undefined;
  cap: number;
  maintenanceProviderSession: boolean;
  repository: GroupProcessingRepository;
  executionProviderId: ExecutionProviderId;
  publish: GroupProcessingDeps['publishRuntimeEvent'];
  appId: string;
  groupName: string;
  loadTurnContext: (
    promoteReadyProviderSession: boolean,
    hydrateMemory?: boolean,
  ) => Promise<AgentTurnContext | undefined>;
  onRetired: (reference: RetiredProviderSessionReference) => void;
}): Promise<ProviderSessionCeilingPreflightResult | undefined> {
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
    loadTurnContext: input.loadTurnContext,
  });
}
