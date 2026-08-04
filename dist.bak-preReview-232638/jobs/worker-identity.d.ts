import type { WorkerRegistryRepository } from '../domain/ports/worker-coordination.js';
import { type ProcessRole } from '../app/bootstrap/roles/process-role.js';
type WarnLog = (context: Record<string, unknown>, message: string) => void;
export declare function registerWorkerInstance(registry: WorkerRegistryRepository, options?: {
    warn?: WarnLog;
    processRole?: ProcessRole;
}): Promise<string>;
export declare function requireWorkerInstanceId(): string;
export declare function currentWorkerInstanceId(): string | null;
export declare function stopWorkerHeartbeat(): void;
export {};
