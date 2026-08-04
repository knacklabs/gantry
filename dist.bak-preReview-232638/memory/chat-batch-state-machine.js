import { createHash, randomUUID } from 'node:crypto';
import { CredentialBrokerPolicyError } from '../domain/models/credential-errors.js';
export const DEFAULT_CHAT_BATCH_MAX_SNAPSHOT_BYTES = 14 * 1024 * 1024;
export const DEFAULT_CHAT_BATCH_RETRY_LIMIT = 5;
export const DEFAULT_CHAT_BATCH_RETENTION_MS = 29 * 24 * 60 * 60 * 1000;
export class ChatBatchStateMachine {
    options;
    now;
    createId;
    maxSnapshotBytes;
    retryLimit;
    retentionMsForProvider;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? (() => new Date());
        this.createId = options.createId ?? randomUUID;
        this.maxSnapshotBytes =
            options.maxSnapshotBytes ?? DEFAULT_CHAT_BATCH_MAX_SNAPSHOT_BYTES;
        this.retryLimit = options.retryLimit ?? DEFAULT_CHAT_BATCH_RETRY_LIMIT;
        this.retentionMsForProvider =
            options.retentionMsForProvider ?? (() => DEFAULT_CHAT_BATCH_RETENTION_MS);
    }
    async submit(input) {
        validateSubmitInput(input, this.maxSnapshotBytes);
        input.signal?.throwIfAborted();
        const capability = this.options.resolveCapability(input);
        if (!capability) {
            throw new Error(`Provider ${input.providerId} has no chat batch capability`);
        }
        const correlationId = input.correlationId ?? `gbc_${this.createId().replaceAll('-', '')}`;
        const requestSnapshot = toRequestSnapshot(input.requests, input.maxOutputTokens);
        const serialized = stableJson({
            model: input.model,
            maxOutputTokens: input.maxOutputTokens,
            requests: requestSnapshot,
        });
        const snapshotBytes = Buffer.byteLength(serialized);
        if (snapshotBytes > this.maxSnapshotBytes) {
            throw new Error(`Chat batch snapshot is ${snapshotBytes} bytes; limit is ${this.maxSnapshotBytes}`);
        }
        const now = this.now();
        const { dayStartIso, dayEndIso } = utcDayBounds(now);
        const intentInput = {
            id: `cb_${this.createId().replaceAll('-', '')}`,
            appId: input.appId,
            providerId: input.providerId,
            model: input.model,
            correlationId,
            contentHash: createHash('sha256').update(serialized).digest('hex'),
            requestSnapshot,
            requestCount: requestSnapshot.length,
            snapshotBytes,
            reservedCostUsd: input.reservedCostUsd,
            dailyCostLimitUsd: input.dailyCostLimitUsd,
            dayStartIso,
            dayEndIso,
            nowIso: now.toISOString(),
        };
        const submission = {
            appId: input.appId,
            model: input.model,
            modelProfile: input.modelProfile,
            correlationId,
            requests: input.requests,
            maxOutputTokens: input.maxOutputTokens,
            signal: input.signal,
        };
        try {
            await capability.preflightBatch(submission);
        }
        catch (error) {
            if (!isCredentialPolicyError(error)) {
                await this.options.repository.recordPreflightFailure({
                    ...intentInput,
                    error: errorMessage(error),
                });
            }
            throw error;
        }
        const intent = await this.options.repository.createIntent(intentInput);
        if (intent.state !== 'submission_intent')
            return intent;
        let submissionStarted = false;
        let submitted;
        try {
            submitted = await capability.submitBatch({
                ...submission,
                onSubmissionStart: async () => {
                    if (submissionStarted) {
                        throw new Error('Chat batch submission start was signaled twice');
                    }
                    const unknown = await this.options.repository.markSubmissionUnknown({
                        id: intent.id,
                        nowIso: this.now().toISOString(),
                    });
                    if (!unknown) {
                        throw new Error('Chat batch intent could not enter submission_unknown before provider send');
                    }
                    submissionStarted = true;
                },
            });
        }
        catch (error) {
            if (!submissionStarted) {
                await this.options.repository.recordPreflightFailure({
                    ...intentInput,
                    error: errorMessage(error),
                    nowIso: this.now().toISOString(),
                });
            }
            throw error;
        }
        if (!submissionStarted) {
            throw new Error('Chat batch transport returned without marking submission started');
        }
        const recorded = await this.options.repository.markSubmitted({
            id: intent.id,
            providerBatchId: submitted.batchId,
            nowIso: this.now().toISOString(),
        });
        if (!recorded) {
            throw new Error('Provider accepted chat batch but its id could not be persisted; reconciliation required');
        }
        return recorded;
    }
    async pollAndApply(input) {
        const batch = await this.requireBatch(input.batchId);
        if (!['submitted', 'processing'].includes(batch.state))
            return batch;
        if (!batch.providerBatchId) {
            throw new Error('Submitted chat batch is missing its provider batch id');
        }
        const capability = this.options.resolveCapability(batch);
        if (!capability) {
            throw new Error(`Provider ${batch.providerId} has no chat batch capability`);
        }
        let poll;
        try {
            poll = await capability.pollBatch({
                appId: batch.appId,
                model: batch.model,
                modelProfile: input.modelProfile,
                batchId: batch.providerBatchId,
                signal: input.signal,
            });
        }
        catch (error) {
            return this.recordAttemptFailure(batch, 'poll', error);
        }
        const processing = (await this.options.repository.markProcessing({
            id: batch.id,
            nowIso: this.now().toISOString(),
        })) ?? batch;
        if (poll.state === 'pending')
            return processing;
        if (poll.state !== 'completed') {
            return ((await this.options.repository.recordAttemptError({
                id: batch.id,
                phase: 'poll',
                error: poll.error ?? `Provider batch ended as ${poll.state}`,
                terminal: true,
                nowIso: this.now().toISOString(),
            })) ?? processing);
        }
        let results;
        try {
            results = await capability.fetchBatchResults({
                appId: batch.appId,
                model: batch.model,
                modelProfile: input.modelProfile,
                batchId: batch.providerBatchId,
                signal: input.signal,
            });
            results = orderCompleteResults(batch, results);
        }
        catch (error) {
            return this.recordAttemptFailure(processing, 'result', error);
        }
        return ((await this.options.repository.applyResults({
            id: batch.id,
            results: toSnapshot(results),
            usage: sumUsage(results),
            nowIso: this.now().toISOString(),
        })) ?? processing);
    }
    async reconcileSubmissionUnknown(input = {}) {
        const rows = await this.options.repository.listSubmissionUnknown({
            appId: input.appId,
            limit: input.limit ?? 100,
        });
        const summary = {
            inspected: rows.length,
            adopted: 0,
            abandoned: 0,
            unresolved: 0,
        };
        for (const row of rows) {
            input.signal?.throwIfAborted();
            const capability = this.options.resolveCapability(row);
            if (capability) {
                try {
                    const match = await capability.findBatchByCorrelationId({
                        appId: row.appId,
                        model: row.model,
                        correlationId: row.correlationId,
                        signal: input.signal,
                    });
                    if (match) {
                        const adopted = await this.options.repository.markSubmitted({
                            id: row.id,
                            providerBatchId: match.batchId,
                            nowIso: this.now().toISOString(),
                        });
                        if (adopted) {
                            summary.adopted += 1;
                            continue;
                        }
                    }
                }
                catch {
                    // Read-only reconciliation is best-effort; unknown work is never resubmitted.
                }
            }
            const ageMs = this.now().getTime() - Date.parse(row.createdAt);
            if (ageMs >= this.retentionMsForProvider(row.providerId)) {
                const abandoned = await this.options.repository.abandonSubmission({
                    id: row.id,
                    reason: 'No metadata-matched provider batch was found before the retention window expired',
                    nowIso: this.now().toISOString(),
                });
                if (abandoned) {
                    summary.abandoned += 1;
                    continue;
                }
            }
            summary.unresolved += 1;
        }
        return summary;
    }
    async requireBatch(id) {
        const batch = await this.options.repository.findById(id);
        if (!batch)
            throw new Error(`Unknown chat batch ${id}`);
        return batch;
    }
    async recordAttemptFailure(batch, phase, error) {
        const attempts = phase === 'poll' ? batch.pollAttempts : batch.resultAttempts;
        return ((await this.options.repository.recordAttemptError({
            id: batch.id,
            phase,
            error: errorMessage(error),
            terminal: attempts + 1 >= this.retryLimit,
            nowIso: this.now().toISOString(),
        })) ?? batch);
    }
}
function validateSubmitInput(input, maxSnapshotBytes) {
    if (input.requests.length === 0) {
        throw new Error('Chat batch requires at least one request');
    }
    if (!Number.isSafeInteger(input.maxOutputTokens) ||
        input.maxOutputTokens < 1) {
        throw new Error('Chat batch max output tokens must be a positive integer');
    }
    if (!Number.isFinite(maxSnapshotBytes) || maxSnapshotBytes <= 0) {
        throw new Error('Chat batch snapshot limit must be positive');
    }
    if (!Number.isFinite(input.reservedCostUsd) || input.reservedCostUsd < 0) {
        throw new Error('Chat batch reserved cost must be non-negative');
    }
    if (!Number.isFinite(input.dailyCostLimitUsd) ||
        input.dailyCostLimitUsd < input.reservedCostUsd) {
        throw new Error('Chat batch daily cost limit cannot cover this submission');
    }
    const ids = new Set();
    for (const request of input.requests) {
        if (!request.customId.trim() || ids.has(request.customId)) {
            throw new Error('Chat batch custom ids must be non-empty and unique');
        }
        ids.add(request.customId);
    }
}
function orderCompleteResults(batch, results) {
    const expected = new Set(batch.requestSnapshot.map((request) => String(request.customId ?? '')));
    const found = new Set();
    for (const result of results) {
        if (!expected.has(result.customId) || found.has(result.customId)) {
            throw new Error(`Unexpected or duplicate chat batch result ${result.customId}`);
        }
        found.add(result.customId);
    }
    if (found.size !== expected.size) {
        throw new Error(`Chat batch result set is incomplete: expected ${expected.size}, received ${found.size}`);
    }
    const byCustomId = new Map(results.map((result) => [result.customId, result]));
    return batch.requestSnapshot.map((request) => byCustomId.get(String(request.customId ?? '')));
}
function sumUsage(results) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let estimatedCostUsd = 0;
    let costRows = 0;
    let costKnown = true;
    for (const result of results) {
        if (!result.usage) {
            if (!result.error)
                costKnown = false;
            continue;
        }
        inputTokens += result.usage.input_tokens;
        outputTokens += result.usage.output_tokens;
        cacheReadTokens += result.usage.cache_read_input_tokens ?? 0;
        cacheWriteTokens += result.usage.cache_creation_input_tokens ?? 0;
        costRows += 1;
        if (typeof result.usage.provider_reported_cost_usd === 'number') {
            estimatedCostUsd += result.usage.provider_reported_cost_usd;
        }
        else {
            costKnown = false;
        }
    }
    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        estimatedCostUsd: costRows > 0 && costKnown ? estimatedCostUsd : null,
    };
}
function toSnapshot(value) {
    return JSON.parse(JSON.stringify(value));
}
function toRequestSnapshot(requests, maxOutputTokens) {
    return toSnapshot(requests.map((request) => ({ ...request, maxOutputTokens })));
}
function stableJson(value) {
    return JSON.stringify(sortJson(value));
}
function sortJson(value) {
    if (Array.isArray(value))
        return value.map(sortJson);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]));
}
function utcDayBounds(now) {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return {
        dayStartIso: dayStart.toISOString(),
        dayEndIso: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isCredentialPolicyError(error) {
    return (error instanceof CredentialBrokerPolicyError ||
        (error instanceof Error && error.name === 'CredentialBrokerPolicyError'));
}
