import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../shared/private-fs.js';
import { claimIpcFile, isPendingIpcJsonFile } from './ipc-filesystem.js';
import type { RunnerControlRequestLane } from './runner-control-port.js';

interface CancellationRecordPayload {
  requestId: string;
  appId?: string;
  sourceAgentFolder: string;
  threadId?: string;
  reason?: string;
}

export interface DurableCancellationRecord<
  Cancellation extends CancellationRecordPayload,
> {
  attempts: number;
  cancellation: Cancellation;
  envelopeDigest: string;
  expiresAt: number;
  nextAttemptAt: number;
}

// Runner sandboxes can write only ipc/<workspace>; this sibling root stays host-owned.
const HOST_CANCELLATION_RECORDS_DIR = '.cancellation-retries';
const WORKER_STARTED_AT_MS = Date.now();
const PROCESSING_RECORD_PATTERN =
  /^\.processing-\d+-\d+-[0-9a-f-]+-(.+\.json)$/;

export function durableCancellationRecordsDir(
  ipcBaseDir: string,
  lane: Extract<
    RunnerControlRequestLane,
    'permission-cancellations' | 'question-cancellations'
  >,
  sourceAgentFolder: string,
): string {
  return path.join(
    ipcBaseDir,
    HOST_CANCELLATION_RECORDS_DIR,
    lane,
    sourceAgentFolder,
  );
}

export function listDurableCancellationRecords(recordsDir: string): string[] {
  ensurePrivateDirSync(recordsDir);
  recoverAbandonedDurableCancellationRecords(recordsDir);
  return fs.readdirSync(recordsDir).filter(isPendingIpcJsonFile);
}

export function createDurableCancellationRecord<
  Cancellation extends CancellationRecordPayload,
>(recordsDir: string, record: DurableCancellationRecord<Cancellation>): string {
  ensurePrivateDirSync(recordsDir);
  const file = `${randomUUID()}.json`;
  const recordPath = path.join(recordsDir, file);
  writeDurableCancellationRecord(recordPath, record);
  return file;
}

export function claimDurableCancellationRecord(
  recordsDir: string,
  file: string,
): string {
  const claimedPath = claimIpcFile(path.join(recordsDir, file));
  const claimedAt = new Date();
  fs.utimesSync(claimedPath, claimedAt, claimedAt);
  return claimedPath;
}

export function readDurableCancellationRecord<
  Cancellation extends CancellationRecordPayload,
>(recordPath: string): DurableCancellationRecord<Cancellation> {
  const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as Partial<
    DurableCancellationRecord<Cancellation>
  > & { version?: unknown };
  if (
    parsed.version !== 1 ||
    typeof parsed.attempts !== 'number' ||
    typeof parsed.envelopeDigest !== 'string' ||
    typeof parsed.expiresAt !== 'number' ||
    typeof parsed.nextAttemptAt !== 'number' ||
    !parsed.cancellation ||
    typeof parsed.cancellation.requestId !== 'string' ||
    typeof parsed.cancellation.appId !== 'string' ||
    typeof parsed.cancellation.sourceAgentFolder !== 'string'
  ) {
    throw new Error('Invalid durable cancellation record');
  }
  return parsed as DurableCancellationRecord<Cancellation>;
}

export function releaseDurableCancellationRecord<
  Cancellation extends CancellationRecordPayload,
>(
  claimedPath: string,
  pendingPath: string,
  record: DurableCancellationRecord<Cancellation>,
): void {
  writeDurableCancellationRecord(claimedPath, record);
  fs.renameSync(claimedPath, pendingPath);
}

function writeDurableCancellationRecord<
  Cancellation extends CancellationRecordPayload,
>(recordPath: string, record: DurableCancellationRecord<Cancellation>): void {
  const tempPath = `${recordPath}.${randomUUID()}.tmp`;
  try {
    writePrivateFileSync(tempPath, JSON.stringify({ version: 1, ...record }));
    fs.renameSync(tempPath, recordPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function recoverAbandonedDurableCancellationRecords(recordsDir: string): void {
  for (const file of fs.readdirSync(recordsDir)) {
    const match = PROCESSING_RECORD_PATTERN.exec(file);
    if (!match) continue;
    const claimedPath = path.join(recordsDir, file);
    if (!isAbandonedClaim(claimedPath)) continue;
    try {
      fs.renameSync(claimedPath, path.join(recordsDir, match[1]));
    } catch (err) {
      if (!hasErrorCode(err, 'ENOENT')) throw err;
    }
  }
}

// ponytail: Gantry runs one host process, so a pre-start claim belongs to a previous incarnation.
function isAbandonedClaim(claimedPath: string): boolean {
  try {
    return fs.statSync(claimedPath).mtimeMs < WORKER_STARTED_AT_MS;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === code
  );
}
