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
  openAiBatchIdFromPath,
  openAiFileContentIdFromPath,
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
  modelBatchId?: string;
  modelBatchUploadedFileIds: Set<string>;
  modelBatchFileIds: Map<string, string>;
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
  method = 'POST',
): boolean {
  const purposeAllowsPath =
    isProviderBatchPath(provider, providerPath) ===
    (token.purpose === 'model_batch');
  if (!purposeAllowsPath || token.purpose !== 'model_batch') {
    return purposeAllowsPath;
  }
  if (provider.id !== 'openai' || method !== 'GET') return true;

  const fileId = openAiFileContentIdFromPath(providerPath);
  if (fileId) {
    return (
      Boolean(token.modelBatchId) &&
      token.modelBatchFileIds.get(fileId) === token.modelBatchId
    );
  }
  const batchId = openAiBatchIdFromPath(providerPath);
  if (batchId) return token.modelBatchId === batchId;
  return true;
}

export function gatewayTokenAllowsRequestBody(
  token: GatewayTokenRecord,
  provider: ModelProviderDefinition,
  providerPath: string,
  method: string,
  body: Buffer,
): boolean {
  if (
    token.purpose !== 'model_batch' ||
    provider.id !== 'openai' ||
    method !== 'POST' ||
    providerPath !== '/v1/batches'
  ) {
    return true;
  }
  const inputFileId = jsonStringField(body, 'input_file_id');
  return Boolean(
    inputFileId && token.modelBatchUploadedFileIds.has(inputFileId),
  );
}

export function recordGatewayBatchFileAssociations(input: {
  token: GatewayTokenRecord;
  provider: ModelProviderDefinition;
  providerPath: string;
  method: string;
  requestBody: Buffer;
  responsePayload?: Record<string, unknown>;
}): void {
  const { token, provider, providerPath, method, responsePayload } = input;
  if (
    token.purpose !== 'model_batch' ||
    provider.id !== 'openai' ||
    !responsePayload
  ) {
    return;
  }
  if (method === 'POST' && providerPath === '/v1/files') {
    const fileId = stringValue(responsePayload.id);
    if (fileId) token.modelBatchUploadedFileIds.add(fileId);
    return;
  }
  if (method === 'POST' && providerPath === '/v1/batches') {
    const inputFileId = jsonStringField(input.requestBody, 'input_file_id');
    const batchId = stringValue(responsePayload.id);
    if (
      !inputFileId ||
      !batchId ||
      !token.modelBatchUploadedFileIds.has(inputFileId)
    ) {
      return;
    }
    token.modelBatchId = batchId;
    token.modelBatchFileIds.set(inputFileId, batchId);
    return;
  }
  if (method !== 'GET') return;
  const batchId = openAiBatchIdFromPath(providerPath);
  if (
    !batchId ||
    token.modelBatchId !== batchId ||
    stringValue(responsePayload.id) !== batchId
  ) {
    return;
  }
  for (const field of ['output_file_id', 'error_file_id']) {
    const fileId = stringValue(responsePayload[field]);
    if (fileId) token.modelBatchFileIds.set(fileId, batchId);
  }
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

function jsonStringField(body: Buffer, field: string): string | undefined {
  /* eslint-disable no-catch-all/no-catch-all -- malformed batch JSON fails closed */
  try {
    const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    return stringValue(parsed[field]);
  } catch {
    return undefined;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
