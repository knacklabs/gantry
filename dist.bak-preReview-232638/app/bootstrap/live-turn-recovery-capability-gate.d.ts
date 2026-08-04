import type { RuntimeDependencyRepository } from '../../domain/ports/fleet-capability-state.js';
import type { LiveTurn } from '../../domain/ports/live-turns.js';
import type { WorkerCoordinationRepository } from '../../domain/ports/worker-coordination.js';
import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { IpcDeps } from '../../runtime/ipc.js';
import type { RuntimeApp } from './runtime-app.js';
export declare function buildLiveTurnRecoveryCapabilityGate(input: {
    app: RuntimeApp;
    workerCoordination?: WorkerCoordinationRepository;
    liveTurnLeaseDeps?: {
        workerInstanceId: string;
    };
    getDeploymentMode: () => string;
    getSkillRepository?: () => SkillCatalogRepository | undefined;
    getRuntimeDependencyRepository?: () => RuntimeDependencyRepository | undefined;
    agentIdForFolder: (folder: string) => string;
    publishRuntimeEvent?: IpcDeps['publishRuntimeEvent'];
    nowMs: () => number;
    warn: (context: Record<string, unknown>, message: string) => void;
}): {
    isEligibleToRecoverLiveTurn: (turn: LiveTurn) => Promise<boolean>;
    alertNoEligibleLiveTurnRecoverer: ((turn: LiveTurn) => Promise<void>) | undefined;
};
