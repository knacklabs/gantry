import type { MemoryBoundaryDefaultScope, SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
type JobMemoryLogger = {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
};
export declare function collectCompactBoundaryMemory(input: {
    compactBoundary?: boolean;
    agentSessionId?: string;
    collectMemory?: SessionMemoryCollector;
    defaultScope?: MemoryBoundaryDefaultScope;
    logger: JobMemoryLogger;
    context?: Record<string, unknown>;
}): Promise<void>;
export declare function collectJobCompletionMemory(input: {
    agentSessionId?: string;
    collectMemory?: SessionMemoryCollector;
    defaultScope?: MemoryBoundaryDefaultScope;
    prompt?: string | null;
    result?: string | null;
    logger: JobMemoryLogger;
    context?: Record<string, unknown>;
}): Promise<void>;
export {};
