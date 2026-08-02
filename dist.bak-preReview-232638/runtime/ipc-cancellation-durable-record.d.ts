import type { RunnerControlRequestLane } from './runner-control-port.js';
interface CancellationRecordPayload {
    requestId: string;
    appId?: string;
    sourceAgentFolder: string;
    threadId?: string;
    reason?: string;
}
export interface DurableCancellationRecord<Cancellation extends CancellationRecordPayload> {
    attempts: number;
    cancellation: Cancellation;
    envelopeDigest: string;
    expiresAt: number;
    nextAttemptAt: number;
}
export declare function durableCancellationRecordsDir(ipcBaseDir: string, lane: Extract<RunnerControlRequestLane, 'permission-cancellations' | 'question-cancellations'>, sourceAgentFolder: string): string;
export declare function listDurableCancellationRecords(recordsDir: string): string[];
export declare function createDurableCancellationRecord<Cancellation extends CancellationRecordPayload>(recordsDir: string, record: DurableCancellationRecord<Cancellation>): string;
export declare function claimDurableCancellationRecord(recordsDir: string, file: string): string;
export declare function readDurableCancellationRecord<Cancellation extends CancellationRecordPayload>(recordPath: string): DurableCancellationRecord<Cancellation>;
export declare function releaseDurableCancellationRecord<Cancellation extends CancellationRecordPayload>(claimedPath: string, pendingPath: string, record: DurableCancellationRecord<Cancellation>): void;
export {};
