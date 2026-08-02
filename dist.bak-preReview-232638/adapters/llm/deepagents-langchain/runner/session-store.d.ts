import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
export declare const MISSING_DEEPAGENTS_SESSION_MARKER = "No DeepAgents session found with session ID";
export interface DeepAgentCheckpointerConfig {
    databaseUrl: string;
    schema: string;
    proxyUrl?: string;
}
export type DeepAgentCheckpointSaver = PostgresSaver;
export interface DeepAgentCheckpointTimingSnapshot {
    loadCount: number;
    loadMs: number;
    maxLoadMs?: number;
    writeCount: number;
    writeMs: number;
    maxWriteMs?: number;
}
export interface DeepAgentCheckpointTiming {
    measureLoad: <T>(work: () => Promise<T>) => Promise<T>;
    measureWrite: <T>(work: () => Promise<T>) => Promise<T>;
    snapshot: () => DeepAgentCheckpointTimingSnapshot;
}
export declare class DeepAgentSessionStore {
    private readonly config;
    private readonly timing?;
    constructor(config: DeepAgentCheckpointerConfig, timing?: DeepAgentCheckpointTiming | undefined);
    static newSessionId(): string;
    newSessionId(): string;
    create(sessionId: string): Promise<DeepAgentCheckpointSaver>;
    load(sessionId: string): Promise<DeepAgentCheckpointSaver>;
    private openSaver;
}
export declare function createDeepAgentCheckpointSaverFromPool(pool: pg.Pool, schema: string, timing?: DeepAgentCheckpointTiming): DeepAgentCheckpointSaver;
export declare function isMissingDeepAgentSessionError(error: string | undefined): boolean;
export declare function createDeepAgentCheckpointTiming(input: {
    nowMs: () => number;
}): DeepAgentCheckpointTiming;
