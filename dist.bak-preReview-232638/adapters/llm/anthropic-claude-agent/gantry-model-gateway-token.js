import { CredentialBrokerPolicyError } from '../../../domain/models/credential-errors.js';
import { isProviderBatchPath, isProviderBatchSubmissionPath, openAiBatchIdFromPath, openAiFileContentIdFromPath, } from './gantry-model-gateway-routing.js';
export function assertGatewayBatchCredential(provider, authMode, purpose) {
    if (purpose === 'model_batch' &&
        !provider.batch?.supportedCredentialModes.includes(authMode.trim())) {
        throw new CredentialBrokerPolicyError(`${provider.label} credential mode ${authMode} does not support chat batches.`);
    }
}
export function batchRequestCountFor(purpose, value) {
    if (purpose !== 'model_batch')
        return 1;
    if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
        throw new CredentialBrokerPolicyError('Gantry Model Gateway batch-purpose tokens require a positive request count.');
    }
    return value;
}
export function gatewayTokenAllowsPath(token, provider, providerPath, method = 'POST') {
    const purposeAllowsPath = isProviderBatchPath(provider, providerPath) ===
        (token.purpose === 'model_batch');
    if (!purposeAllowsPath || token.purpose !== 'model_batch') {
        return purposeAllowsPath;
    }
    if (provider.id !== 'openai' || method !== 'GET')
        return true;
    const fileId = openAiFileContentIdFromPath(providerPath);
    if (fileId) {
        return (Boolean(token.modelBatchId) &&
            token.modelBatchFileIds.get(fileId) === token.modelBatchId);
    }
    const batchId = openAiBatchIdFromPath(providerPath);
    if (batchId)
        return token.modelBatchId === batchId;
    return true;
}
export function gatewayTokenAllowsRequestBody(token, provider, providerPath, method, body) {
    if (token.purpose !== 'model_batch' ||
        provider.id !== 'openai' ||
        method !== 'POST' ||
        providerPath !== '/v1/batches') {
        return true;
    }
    const inputFileId = jsonStringField(body, 'input_file_id');
    return Boolean(inputFileId && token.modelBatchUploadedFileIds.has(inputFileId));
}
export function recordGatewayBatchFileAssociations(input) {
    const { token, provider, providerPath, method, responsePayload } = input;
    if (token.purpose !== 'model_batch' ||
        provider.id !== 'openai' ||
        !responsePayload) {
        return;
    }
    if (method === 'POST' && providerPath === '/v1/files') {
        const fileId = stringValue(responsePayload.id);
        if (fileId)
            token.modelBatchUploadedFileIds.add(fileId);
        return;
    }
    if (method === 'POST' && providerPath === '/v1/batches') {
        const inputFileId = jsonStringField(input.requestBody, 'input_file_id');
        const batchId = stringValue(responsePayload.id);
        if (!inputFileId ||
            !batchId ||
            !token.modelBatchUploadedFileIds.has(inputFileId)) {
            return;
        }
        token.modelBatchId = batchId;
        token.modelBatchFileIds.set(inputFileId, batchId);
        return;
    }
    if (method !== 'GET')
        return;
    const batchId = openAiBatchIdFromPath(providerPath);
    if (!batchId ||
        token.modelBatchId !== batchId ||
        stringValue(responsePayload.id) !== batchId) {
        return;
    }
    for (const field of ['output_file_id', 'error_file_id']) {
        const fileId = stringValue(responsePayload[field]);
        if (fileId)
            token.modelBatchFileIds.set(fileId, batchId);
    }
}
export function gatewayRateWeight(token, provider, providerPath, method) {
    return isProviderBatchSubmissionPath(provider, providerPath, method)
        ? token.modelBatchRequestCount
        : 1;
}
export function gatewayTokenScope(binding) {
    const prefix = binding.purpose === 'model_batch' ? 'batch:' : '';
    if (binding.apiKeyId) {
        return `${prefix}api_key:${[binding.apiKeyId, binding.apiRequestId]
            .filter(Boolean)
            .join(':')}`;
    }
    if (binding.runId)
        return `${prefix}run:${String(binding.runId)}`;
    return `${prefix}unscoped`;
}
export function isRevocableGatewayTokenScope(scope) {
    const normalized = scope.startsWith('batch:') ? scope.slice(6) : scope;
    return normalized.startsWith('run:') || normalized.startsWith('api_key:');
}
export function runtimeEventRunIdFor(token) {
    if (!token.runId)
        return undefined;
    const runId = String(token.runId);
    return runId.startsWith('credential-run:') ||
        runId.startsWith('memory-query:')
        ? undefined
        : token.runId;
}
function jsonStringField(body, field) {
    /* eslint-disable no-catch-all/no-catch-all -- malformed batch JSON fails closed */
    try {
        const parsed = JSON.parse(body.toString('utf8'));
        return stringValue(parsed[field]);
    }
    catch {
        return undefined;
    }
    /* eslint-enable no-catch-all/no-catch-all */
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
