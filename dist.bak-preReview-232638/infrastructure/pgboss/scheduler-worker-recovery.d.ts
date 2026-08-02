import type { WorkerCoordinationRepository } from '../../domain/ports/worker-coordination.js';
export declare function recoverExpiredWorkerLeases(input: {
    coordination: WorkerCoordinationRepository;
    logger: {
        warn(context: Record<string, unknown>, message: string): void;
    };
}): Promise<void>;
