import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { IPC_CANCELLATION_RETENTION_TTL_MS } from '../shared/ipc-cancellation-lifetime.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import { claimDurableCancellationRecord, createDurableCancellationRecord, durableCancellationRecordsDir, listDurableCancellationRecords, readDurableCancellationRecord, releaseDurableCancellationRecord, } from './ipc-cancellation-durable-record.js';
import { archiveIpcErrorFile } from './ipc-filesystem.js';
import { interactionInFlightKey } from './ipc-interaction-processing.js';
const CANCELLATION_RETRY_MIN_MS = 1_000;
const CANCELLATION_RETRY_MAX_MS = 30_000;
const IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export async function processCancellationDirectory(input, lane) {
    const { sourceAgentFolder, runnerControlPort, logger } = input;
    const cancellationsDir = runnerControlPort.requestDir(sourceAgentFolder, lane.requestLane);
    try {
        if (!input.shouldProcessRequestLane(sourceAgentFolder, lane.requestLane) ||
            !runnerControlPort.isTrustedRequestDir(sourceAgentFolder, lane.requestLane)) {
            return;
        }
        const files = runnerControlPort.listPendingRequests(sourceAgentFolder, lane.requestLane);
        const recordsDir = durableCancellationRecordsDir(runnerControlPort.baseDir, lane.requestLane, sourceAgentFolder);
        const retryFiles = listDurableCancellationRecords(recordsDir);
        const now = Date.now();
        for (const file of files) {
            await ingestCancellationFile(input, lane, cancellationsDir, recordsDir, file);
        }
        for (const file of retryFiles) {
            const retry = loadPendingCancellationRetryState(recordsDir, file);
            if (retry && retry.nextAttemptAt > now && retry.expiresAt > now) {
                continue;
            }
            await processCancellationRecord(input, lane, recordsDir, file);
        }
    }
    catch (err) {
        logger.error({ err, sourceAgentFolder }, `Error reading ${lane.logLabel} IPC requests directory`);
    }
}
async function ingestCancellationFile(input, lane, cancellationsDir, recordsDir, file) {
    const { sourceAgentFolder, runnerControlPort, logger } = input;
    let claimedPath = path.join(cancellationsDir, file);
    let recordFile;
    let raw;
    try {
        const claimed = runnerControlPort.claimRequest(sourceAgentFolder, lane.requestLane, file);
        claimedPath = claimed.claimedPath;
        raw = claimed.raw;
        const envelopeDigest = cancellationEnvelopeDigest(claimed.raw);
        const cancellation = lane.parser(claimed.raw, sourceAgentFolder);
        const now = Date.now();
        recordFile = createDurableCancellationRecord(recordsDir, {
            attempts: 0,
            cancellation,
            envelopeDigest,
            expiresAt: Math.min(now, fs.statSync(claimedPath).mtimeMs) +
                IPC_CANCELLATION_RETENTION_TTL_MS,
            nextAttemptAt: now,
        });
        fs.unlinkSync(claimedPath);
    }
    catch (err) {
        logger.error({ file, sourceAgentFolder, err }, `Error processing ${lane.logLabel} IPC request`);
        archiveIpcErrorFile(runnerControlPort.baseDir, sourceAgentFolder, file, claimedPath, lane.requestLane);
        if (isAuthenticationFreshnessExpiry(err, lane.logLabel)) {
            const cancellation = readExpiredCancellation(raw, sourceAgentFolder, lane.requestIdField);
            if (cancellation) {
                await publishDiscardedCancellationRuntimeEvent(input, lane, cancellation, 'authentication_freshness_expired');
            }
        }
        return;
    }
    await processCancellationRecord(input, lane, recordsDir, recordFile);
}
async function processCancellationRecord(input, lane, recordsDir, file) {
    const { sourceAgentFolder, runnerControlPort, logger } = input;
    let claimedPath = path.join(recordsDir, file);
    try {
        claimedPath = claimDurableCancellationRecord(recordsDir, file);
        const retry = readDurableCancellationRecord(claimedPath);
        const cancellation = retry.cancellation;
        if (!input.inFlightInteractionIpc.has(interactionInFlightKey({
            sourceAgentFolder: cancellation.sourceAgentFolder,
            kind: lane.inFlightKind,
            threadId: cancellation.threadId,
            requestId: cancellation.requestId,
        }))) {
            if (runnerControlPort.responseExists(sourceAgentFolder, lane.responseLane, cancellation.requestId)) {
                fs.unlinkSync(claimedPath);
                return;
            }
            await retainCancellation({
                input,
                lane,
                claimedPath,
                recordsDir,
                file,
                logger,
                sourceAgentFolder,
                retry,
                logLabel: lane.logLabel,
            });
            return;
        }
        if (!lane.handler) {
            throw new Error(`${lane.missingHandlerErrorLabel} handler is unavailable`);
        }
        let result;
        try {
            result = await lane.handler(cancellation);
        }
        catch (err) {
            logger.error({ file, sourceAgentFolder, err }, `Error processing ${lane.logLabel} IPC request`);
            await retainCancellation({
                input,
                lane,
                claimedPath,
                recordsDir,
                file,
                logger,
                sourceAgentFolder,
                retry,
                logLabel: lane.logLabel,
            });
            return;
        }
        if (result === 'settled') {
            fs.unlinkSync(claimedPath);
            return;
        }
        await retainCancellation({
            input,
            lane,
            claimedPath,
            recordsDir,
            file,
            logger,
            sourceAgentFolder,
            retry,
            logLabel: lane.logLabel,
        });
    }
    catch (err) {
        logger.error({ file, sourceAgentFolder, err }, `Error processing ${lane.logLabel} IPC request`);
        archiveIpcErrorFile(runnerControlPort.baseDir, sourceAgentFolder, file, claimedPath, lane.requestLane);
    }
}
async function retainCancellation(input) {
    const now = Date.now();
    if (input.retry.expiresAt <= now) {
        archiveIpcErrorFile(input.input.runnerControlPort.baseDir, input.sourceAgentFolder, input.file, input.claimedPath, input.lane.requestLane);
        input.logger.warn({
            file: input.file,
            sourceAgentFolder: input.sourceAgentFolder,
            retentionMs: IPC_CANCELLATION_RETENTION_TTL_MS,
        }, `Discarding expired ${input.logLabel} IPC request`);
        await publishDiscardedCancellationRuntimeEvent(input.input, input.lane, input.retry.cancellation, 'retention_expired');
        return;
    }
    const attempts = input.retry.attempts + 1;
    const retryDelayMs = Math.min(CANCELLATION_RETRY_MIN_MS * 2 ** (attempts - 1), CANCELLATION_RETRY_MAX_MS);
    releaseDurableCancellationRecord(input.claimedPath, path.join(input.recordsDir, input.file), {
        ...input.retry,
        attempts,
        nextAttemptAt: now + retryDelayMs,
    });
}
function isAuthenticationFreshnessExpiry(err, logLabel) {
    return (err instanceof Error &&
        err.message === `Invalid ${logLabel} IPC freshness: expired request`);
}
function readExpiredCancellation(raw, sourceAgentFolder, requestIdField) {
    if (!isPlainObject(raw))
        return undefined;
    const context = isPlainObject(raw.context) ? raw.context : undefined;
    const appId = toTrimmedString(context?.appId ?? raw.appId, { maxLen: 128 });
    const threadId = toTrimmedString(context?.threadId ?? raw.threadId, {
        maxLen: 200,
    });
    const requestId = toTrimmedString(raw[requestIdField], { maxLen: 128 });
    if (!appId || !requestId || !IPC_REQUEST_ID_PATTERN.test(requestId)) {
        return undefined;
    }
    return {
        appId,
        requestId,
        sourceAgentFolder,
        ...(threadId ? { threadId } : {}),
    };
}
async function publishDiscardedCancellationRuntimeEvent(input, lane, cancellation, exhaustionReason) {
    if (!input.publishRuntimeEvent || !cancellation.appId)
        return;
    try {
        await input.publishRuntimeEvent({
            appId: cancellation.appId,
            threadId: cancellation.threadId,
            eventType: RUNTIME_EVENT_TYPES.INTERACTION_CANCELLATION_DISCARDED,
            actor: 'interaction',
            correlationId: cancellation.requestId,
            payload: {
                kind: lane.inFlightKind === 'user-question' ? 'question' : 'permission',
                requestId: cancellation.requestId,
                sourceAgentFolder: cancellation.sourceAgentFolder,
                exhaustionReason,
            },
        });
    }
    catch {
        // The archive is durable; runtime-event notification is best-effort.
    }
}
function cancellationEnvelopeDigest(raw) {
    return createHash('sha256').update(JSON.stringify(raw)).digest('hex');
}
function loadPendingCancellationRetryState(recordsDir, file) {
    try {
        return readDurableCancellationRecord(path.join(recordsDir, file));
    }
    catch {
        return undefined;
    }
}
