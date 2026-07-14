import type {
  AgentCredentialPurpose,
  AgentCredentialBrokerBinding,
  AgentCredentialInjection,
  CredentialBrokerProfile,
} from '../../domain/models/credentials.js';
import {
  MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
  MODEL_RUNTIME_CREDENTIAL_NAME,
} from '../../domain/models/credentials.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import { isCredentialBrokerBoundaryError } from '../../domain/models/credential-errors.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../../domain/conversation/conversation.js';
import type { AgentRunId } from '../../domain/events/events.js';
import type { JobId } from '../../domain/jobs/jobs.js';
import type { ModelCredentialProvider } from '../../domain/model-credentials/model-credentials.js';
import type { ModelRouteId } from '../../shared/model-catalog.js';

export type AgentCredentialInjectionInput =
  | {
      mode: 'gantry';
      purpose?: AgentCredentialPurpose;
      appId?: AppId;
      agentId?: AgentId;
      runId?: AgentRunId;
      apiKeyId?: string;
      apiRequestId?: string;
      jobId?: JobId;
      conversationId?: ConversationId;
      threadId?: ConversationThreadId;
      modelCredentialProviderId?: ModelCredentialProvider;
      modelRouteId?: ModelRouteId;
      agentIdentifier?: string;
      broker: AgentCredentialBroker;
    }
  | {
      mode: 'none';
      purpose?: AgentCredentialPurpose;
      agentIdentifier?: string;
    };

function brokerBindingFor(input: {
  mode: CredentialBrokerProfile;
  purpose?: AgentCredentialPurpose;
  appId?: AppId;
  agentId?: AgentId;
  runId?: AgentRunId;
  apiKeyId?: string;
  apiRequestId?: string;
  jobId?: JobId;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  modelCredentialProviderId?: ModelCredentialProvider;
  modelRouteId?: ModelRouteId;
  agentIdentifier?: string;
}): AgentCredentialBrokerBinding {
  const purpose = input.purpose ?? 'model_runtime';
  return {
    profile: input.mode,
    purpose,
    ...('appId' in input && input.appId ? { appId: input.appId } : {}),
    ...('agentId' in input && input.agentId ? { agentId: input.agentId } : {}),
    ...('runId' in input && input.runId ? { runId: input.runId } : {}),
    ...('apiKeyId' in input && input.apiKeyId
      ? { apiKeyId: input.apiKeyId }
      : {}),
    ...('apiRequestId' in input && input.apiRequestId
      ? { apiRequestId: input.apiRequestId }
      : {}),
    ...('jobId' in input && input.jobId ? { jobId: input.jobId } : {}),
    ...('conversationId' in input && input.conversationId
      ? { conversationId: input.conversationId }
      : {}),
    ...('threadId' in input && input.threadId
      ? { threadId: input.threadId }
      : {}),
    ...('modelCredentialProviderId' in input && input.modelCredentialProviderId
      ? { modelCredentialProviderId: input.modelCredentialProviderId }
      : {}),
    ...('modelRouteId' in input && input.modelRouteId
      ? { modelRouteId: input.modelRouteId }
      : {}),
    ...(purpose === 'tool_capability'
      ? { agentIdentifier: input.agentIdentifier }
      : {}),
  };
}

function describeBrokerError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code || '')
      : '';
  return [code, message].filter(Boolean).join(': ') || 'unknown error';
}

function recoveryHintFor(mode: CredentialBrokerProfile): string {
  if (mode === 'gantry') {
    return 'Run `gantry credentials model status` and add the missing provider key with `gantry credentials model set <provider>`.';
  }
  return 'Run `gantry doctor` and configure Gantry Model Access before selecting provider-backed models.';
}

export async function getAgentCredentialInjection(
  input: AgentCredentialInjectionInput,
): Promise<AgentCredentialInjection> {
  if (input.mode === 'none') {
    return {
      env: {},
      applied: false,
      brokerProfile: 'none',
    };
  }

  const broker = input.broker;
  if (!broker) {
    throw new Error(
      'Gantry Model Gateway is enabled but no model gateway broker was provided.',
    );
  }

  try {
    return await broker.getInjection({
      binding: brokerBindingFor(input),
    });
  } catch (err) {
    if (isCredentialBrokerBoundaryError(err)) {
      throw err;
    }
    const purpose = input.purpose ?? 'model_runtime';
    const suffix =
      purpose === 'model_runtime'
        ? ` for ${MODEL_RUNTIME_CREDENTIAL_NAME}`
        : input.agentIdentifier
          ? ` for agent ${input.agentIdentifier}`
          : '';
    const health = await broker
      .healthCheck({ binding: brokerBindingFor(input) })
      .catch(() => undefined);
    const details = [
      `Reason: ${describeBrokerError(err)}.`,
      health && health.status !== 'pass'
        ? `Broker health: ${health.message}`
        : undefined,
      health?.nextAction ? `Next action: ${health.nextAction}` : undefined,
      `Recovery: ${recoveryHintFor(input.mode)}`,
    ].filter(Boolean);
    throw new Error(
      `Gantry Model Gateway is enabled but is not reachable${suffix}. ${details.join(' ')}`,
      { cause: err },
    );
  }
}

export async function ensureModelCredentialBinding(input: {
  mode: CredentialBrokerProfile;
  broker?: AgentCredentialBroker;
}): Promise<{ created?: boolean } | undefined> {
  return ensureAgentCredentialBinding({
    mode: input.mode,
    broker: input.broker,
    name: MODEL_RUNTIME_CREDENTIAL_NAME,
    identifier: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
  });
}

export async function ensureAgentCredentialBinding(input: {
  mode: CredentialBrokerProfile;
  broker?: AgentCredentialBroker;
  name: string;
  identifier: string;
}): Promise<{ created?: boolean } | undefined> {
  void input;
  return undefined;
}
