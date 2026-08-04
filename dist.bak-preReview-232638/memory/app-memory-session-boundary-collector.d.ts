import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
interface SessionBoundaryCollectorDeps {
    repositories: any;
    memory: {
        recordEvidence: (value: any) => Promise<{
            id: string;
        }>;
    };
}
export declare function collectDurableMemoryAtBoundary(input: Parameters<SessionMemoryCollector>[0], deps: SessionBoundaryCollectorDeps): ReturnType<SessionMemoryCollector>;
export {};
