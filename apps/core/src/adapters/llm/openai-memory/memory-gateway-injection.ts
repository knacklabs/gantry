import {
  getCredentialBrokerRuntimeConfig,
  getRuntimeSettingsForConfig,
} from '../../../config/index.js';
import { getAgentCredentialInjection } from '../../../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../../credentials/agent-credential-broker-factory.js';
import { getRuntimeStorage } from '../../storage/postgres/runtime-store.js';
import type { AgentCredentialBroker } from '../../../domain/ports/agent-credential-broker.js';
import type { AgentCredentialInjection } from '../../../domain/models/credentials.js';
import type { AgentCredentialPurpose } from '../../../domain/models/credentials.js';
import type { AgentRunId } from '../../../domain/events/events.js';
import type { AppId } from '../../../domain/app/app.js';
import type { ModelRouteId } from '../../../shared/model-catalog.js';
import { logger } from '../../../infrastructure/logging/logger.js';

/**
 * Brokered model-gateway access for host-side direct queries. Host work has no
 * agent engine in scope, so the credential lane is chosen by the model route
 * alone. This uses the same Gantry loopback gateway and run-scoped bearer-token
 * authority as the Anthropic Agent SDK memory path.
 */
let memoryCredentialBrokerPromise:
  | Promise<AgentCredentialBroker | undefined>
  | undefined;
let memoryCredentialBrokerConfigKey = '';

export function hasGatewayMemoryAccess(): boolean {
  return getCredentialBrokerRuntimeConfig().mode === 'gantry';
}

export interface GatewayMemoryInjection {
  injection: AgentCredentialInjection;
  revoke: () => Promise<void>;
}

export async function resolveGatewayMemoryInjection(input: {
  appId: AppId;
  modelRouteId: ModelRouteId;
  runId: AgentRunId;
  purpose?: Extract<AgentCredentialPurpose, 'model_runtime' | 'model_batch'>;
  modelBatchRequestCount?: number;
  modelBatchId?: string;
}): Promise<GatewayMemoryInjection> {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  const configKey = `${brokerConfig.mode}:${brokerConfig.gatewayBindHost}`;
  if (memoryCredentialBrokerConfigKey !== configKey) {
    void memoryCredentialBrokerPromise
      ?.then((broker) => broker?.close?.())
      .catch((error) => {
        logger.warn(
          { err: error },
          'Failed to close replaced memory credential broker',
        );
      });
    memoryCredentialBrokerPromise = undefined;
    memoryCredentialBrokerConfigKey = configKey;
  }
  if (brokerConfig.mode !== 'gantry') {
    throw new Error('Gantry Model Gateway is not configured for memory access');
  }
  memoryCredentialBrokerPromise ??= createAgentCredentialBroker({
    mode: brokerConfig.mode,
    modelCredentials: getRuntimeStorage().repositories.modelCredentials,
    gatewayBindHost: brokerConfig.gatewayBindHost,
    publishRuntimeEvent: (event) =>
      getRuntimeStorage().runtimeEvents.publish(event),
    // Honor per-provider rate caps for memory traffic, same getter runtime-app
    // uses for the interactive broker. Without it the broker admits unlimited.
    limits: () => getRuntimeSettingsForConfig().limits,
  }).catch((error) => {
    memoryCredentialBrokerPromise = undefined;
    throw error;
  });
  const broker = requireGatewayBroker(await memoryCredentialBrokerPromise);
  const injection = await getAgentCredentialInjection({
    mode: 'gantry',
    purpose: input.purpose ?? 'model_runtime',
    appId: input.appId,
    runId: input.runId,
    modelRouteId: input.modelRouteId,
    ...(input.modelBatchRequestCount
      ? { modelBatchRequestCount: input.modelBatchRequestCount }
      : {}),
    ...(input.modelBatchId ? { modelBatchId: input.modelBatchId } : {}),
    broker,
  });
  return {
    injection,
    revoke: () =>
      broker.revokeInjection?.({
        binding: {
          profile: 'gantry',
          purpose: input.purpose ?? 'model_runtime',
          appId: input.appId,
          runId: input.runId,
          modelRouteId: input.modelRouteId,
          ...(input.modelBatchRequestCount
            ? { modelBatchRequestCount: input.modelBatchRequestCount }
            : {}),
          ...(input.modelBatchId ? { modelBatchId: input.modelBatchId } : {}),
        },
      }) ?? Promise.resolve(),
  };
}

function requireGatewayBroker(
  broker: AgentCredentialBroker | undefined,
): AgentCredentialBroker {
  if (!broker) {
    throw new Error(
      'Gantry Model Gateway is enabled but no model gateway broker was provided.',
    );
  }
  return broker;
}
