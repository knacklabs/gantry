import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ensurePrivateDirSync, writePrivateFileSync, } from '../shared/private-fs.js';
import { claimIpcFile, isPendingIpcJsonFile } from './ipc-filesystem.js';
// Runner sandboxes can write only ipc/<workspace>; this sibling root stays host-owned.
const HOST_CANCELLATION_RECORDS_DIR = '.cancellation-retries';
const WORKER_STARTED_AT_MS = Date.now();
const PROCESSING_RECORD_PATTERN = /^\.processing-\d+-\d+-[0-9a-f-]+-(.+\.json)$/;
export function durableCancellationRecordsDir(ipcBaseDir, lane, sourceAgentFolder) {
    return path.join(ipcBaseDir, HOST_CANCELLATION_RECORDS_DIR, lane, sourceAgentFolder);
}
export function listDurableCancellationRecords(recordsDir) {
    ensurePrivateDirSync(recordsDir);
    recoverAbandonedDurableCancellationRecords(recordsDir);
    return fs.readdirSync(recordsDir).filter(isPendingIpcJsonFile);
}
export function createDurableCancellationRecord(recordsDir, record) {
    ensurePrivateDirSync(recordsDir);
    const file = `${randomUUID()}.json`;
    const recordPath = path.join(recordsDir, file);
    writeDurableCancellationRecord(recordPath, record);
    return file;
}
export function claimDurableCancellationRecord(recordsDir, file) {
    const claimedPath = claimIpcFile(path.join(recordsDir, file));
    const claimedAt = new Date();
    fs.utimesSync(claimedPath, claimedAt, claimedAt);
    return claimedPath;
}
export function readDurableCancellationRecord(recordPath) {
    const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
    if (parsed.version !== 1 ||
        typeof parsed.attempts !== 'number' ||
        typeof parsed.envelopeDigest !== 'string' ||
        typeof parsed.expiresAt !== 'number' ||
        typeof parsed.nextAttemptAt !== 'number' ||
        !parsed.cancellation ||
        typeof parsed.cancellation.requestId !== 'string' ||
        typeof parsed.cancellation.appId !== 'string' ||
        typeof parsed.cancellation.sourceAgentFolder !== 'string') {
        throw new Error('Invalid durable cancellation record');
    }
    return parsed;
}
export function releaseDurableCancellationRecord(claimedPath, pendingPath, record) {
    writeDurableCancellationRecord(claimedPath, record);
    fs.renameSync(claimedPath, pendingPath);
}
function writeDurableCancellationRecord(recordPath, record) {
    const tempPath = `${recordPath}.${randomUUID()}.tmp`;
    try {
        writePrivateFileSync(tempPath, JSON.stringify({ version: 1, ...record }));
        fs.renameSync(tempPath, recordPath);
    }
    finally {
        fs.rmSync(tempPath, { force: true });
    }
}
function recoverAbandonedDurableCancellationRecords(recordsDir) {
    for (const file of fs.readdirSync(recordsDir)) {
        const match = PROCESSING_RECORD_PATTERN.exec(file);
        if (!match)
            continue;
        const claimedPath = path.join(recordsDir, file);
        if (!isAbandonedClaim(claimedPath))
            continue;
        try {
            fs.renameSync(claimedPath, path.join(recordsDir, match[1]));
        }
        catch (err) {
            if (!hasErrorCode(err, 'ENOENT'))
                throw err;
        }
    }
}
// ponytail: Gantry runs one host process, so a pre-start claim belongs to a previous incarnation.
function isAbandonedClaim(claimedPath) {
    try {
        return fs.statSync(claimedPath).mtimeMs < WORKER_STARTED_AT_MS;
    }
    catch (err) {
        if (hasErrorCode(err, 'ENOENT'))
            return false;
        throw err;
    }
}
function hasErrorCode(err, code) {
    return (typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === code);
}
