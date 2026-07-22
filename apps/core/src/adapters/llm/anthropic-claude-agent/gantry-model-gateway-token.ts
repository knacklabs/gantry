import type { AppId } from '../../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../../domain/events/events.js';
import { CredentialBrokerPolicyError } from '../../../domain/models/credential-errors.js';
import type {
  AgentCredentialBrokerBinding,
  AgentCredentialPurpose,
} from '../../../domain/models/credentials.js';
import type { ModelCredentialProvider } from '../../../domain/model-credentials/model-credentials.js';
import type { ModelProviderDefinition } from '../../../shared/model-provider-registry.js';
import {
  isProviderBatchPath,
  isProviderBatchSubmissionPath,
} from './gantry-model-gateway-routing.js';

export interface GatewayTokenRecord {
  token: string;
  appId: AppId;
  providerId: ModelCredentialProvider;
  authMode: string;
  schemaVersion: number;
  credentialFingerprint: string;
  createdAtMs: number;
  expiresAtMs: number;
  tokenScope: string;
  purpose: AgentCredentialPurpose;
  modelBatchRequestCount: number;
  agentId?: RuntimeEventPublishInput['agentId'];
  runId?: RuntimeEventPublishInput['runId'];
  apiKeyId?: string;
  apiRequestId?: string;
  jobId?: RuntimeEventPublishInput['jobId'];
  conversationId?: RuntimeEventPublishInput['conversationId'];
  threadId?: RuntimeEventPublishInput['threadId'];
}

export function assertGatewayBatchCredential(
  provider: ModelProviderDefinition,
  authMode: string,
  purpose: AgentCredentialPurpose,
): void {
  if (
    purpose === 'model_batch' &&
    !provider.batch?.supportedCredentialModes.includes(authMode.trim())
  ) {
    throw new CredentialBrokerPolicyError(
      `${provider.label} credential mode ${authMode} does not support chat batches.`,
    );
  }
}

export function batchRequestCountFor(
  purpose: AgentCredentialPurpose,
  value: number | undefined,
): number {
  if (purpose !== 'model_batch') return 1;
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new CredentialBrokerPolicyError(
      'Gantry Model Gateway batch-purpose tokens require a positive request count.',
    );
  }
  return value!;
}

export function gatewayTokenAllowsPath(
  token: GatewayTokenRecord,
  provider: ModelProviderDefinition,
  providerPath: string,
): boolean {
  return (
    isProviderBatchPath(provider, providerPath) ===
    (token.purpose === 'model_batch')
  );
}

export function gatewayRateWeight(
  token: GatewayTokenRecord,
  provider: ModelProviderDefinition,
  providerPath: string,
  method: string,
): number {
  return isProviderBatchSubmissionPath(provider, providerPath, method)
    ? token.modelBatchRequestCount
    : 1;
}

export function gatewayTokenScope(
  binding: AgentCredentialBrokerBinding,
): string {
  const prefix = binding.purpose === 'model_batch' ? 'batch:' : '';
  if (binding.apiKeyId) {
    return `${prefix}api_key:${[binding.apiKeyId, binding.apiRequestId]
      .filter(Boolean)
      .join(':')}`;
  }
  if (binding.runId) return `${prefix}run:${String(binding.runId)}`;
  return `${prefix}unscoped`;
}

export function isRevocableGatewayTokenScope(scope: string): boolean {
  const normalized = scope.startsWith('batch:') ? scope.slice(6) : scope;
  return normalized.startsWith('run:') || normalized.startsWith('api_key:');
}

export function runtimeEventRunIdFor(
  token: GatewayTokenRecord,
): RuntimeEventPublishInput['runId'] | undefined {
  if (!token.runId) return undefined;
  const runId = String(token.runId);
  return runId.startsWith('credential-run:') ||
    runId.startsWith('memory-query:')
    ? undefined
    : token.runId;
}
