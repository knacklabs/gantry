import type { RuntimeDependencyRepository } from '../../domain/ports/fleet-capability-state.js';
import type { LiveTurn } from '../../domain/ports/live-turns.js';
import type { WorkerCoordinationRepository } from '../../domain/ports/worker-coordination.js';
import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import {
  isWorkerEligibleForRequiredCapabilities,
  resolveRequiredCapabilities,
} from '../../jobs/capability-eligibility.js';
import {
  CapabilityStarvationAlerter,
  fleetMissingRequiredCapabilities,
} from '../../jobs/capability-starvation.js';
import { WORKER_STALE_AFTER_MS } from '../../shared/worker-heartbeat.js';
import type { IpcDeps } from '../../runtime/ipc.js';
import {
  findConversationRouteForQueue,
  makeThreadQueueKey,
} from '../../shared/thread-queue-key.js';
import type { RuntimeApp } from './runtime-app.js';

const UNRESOLVED_LIVE_TURN_OWNER_CAPABILITY =
  'gantry:unresolved-live-turn-owner';

export function buildLiveTurnRecoveryCapabilityGate(input: {
  app: RuntimeApp;
  workerCoordination?: WorkerCoordinationRepository;
  liveTurnLeaseDeps?: { workerInstanceId: string };
  getDeploymentMode: () => string;
  getSkillRepository?: () => SkillCatalogRepository | undefined;
  getRuntimeDependencyRepository?: () =>
    RuntimeDependencyRepository | undefined;
  agentIdForFolder: (folder: string) => string;
  publishRuntimeEvent?: IpcDeps['publishRuntimeEvent'];
  nowMs: () => number;
  warn: (context: Record<string, unknown>, message: string) => void;
}): {
  isEligibleToRecoverLiveTurn: (turn: LiveTurn) => Promise<boolean>;
  alertNoEligibleLiveTurnRecoverer:
    ((turn: LiveTurn) => Promise<void>) | undefined;
} {
  const starvationAlerter = input.publishRuntimeEvent
    ? new CapabilityStarvationAlerter({
        publishRuntimeEvent: input.publishRuntimeEvent,
        warn: input.warn,
      })
    : undefined;
  const requiredCapabilitiesForLiveTurn = async (
    turn: LiveTurn,
  ): Promise<string[]> => {
    const pendingQueueJid =
      turn.pendingMessage &&
      typeof turn.pendingMessage === 'object' &&
      !Array.isArray(turn.pendingMessage) &&
      typeof turn.pendingMessage.queueJid === 'string'
        ? turn.pendingMessage.queueJid
        : undefined;
    const route = findConversationRouteForQueue(
      input.app.getConversationRoutes(),
      pendingQueueJid ?? makeThreadQueueKey(turn.conversationId, turn.threadId),
      (candidate) => input.agentIdForFolder(candidate.folder),
    );
    const folder = route?.folder;
    if (!folder) {
      // ponytail: sentinel keeps fleet recovery fail-closed without widening
      // the capability-gate return type.
      return [UNRESOLVED_LIVE_TURN_OWNER_CAPABILITY];
    }
    return resolveRequiredCapabilities(
      {
        deploymentMode: 'fleet',
        skills: input.getSkillRepository?.(),
        runtimeDependencies: input.getRuntimeDependencyRepository?.(),
      },
      { appId: turn.appId, agentId: input.agentIdForFolder(folder) },
    );
  };
  const isEligibleToRecoverLiveTurn = async (
    turn: LiveTurn,
  ): Promise<boolean> => {
    if (input.getDeploymentMode() !== 'fleet') return true;
    if (!input.workerCoordination || !input.liveTurnLeaseDeps) return true;
    const required = await requiredCapabilitiesForLiveTurn(turn);
    if (required.length === 0) return true;
    const worker = await input.workerCoordination.getWorker(
      input.liveTurnLeaseDeps.workerInstanceId,
    );
    if (!worker) return true;
    return isWorkerEligibleForRequiredCapabilities(
      required,
      worker.capabilities,
    );
  };
  const alertNoEligibleLiveTurnRecoverer = async (
    turn: LiveTurn,
  ): Promise<void> => {
    if (!input.workerCoordination || !starvationAlerter) return;
    const required = await requiredCapabilitiesForLiveTurn(turn);
    if (required.length === 0) return;
    const staleBefore = new Date(
      input.nowMs() - WORKER_STALE_AFTER_MS,
    ).toISOString();
    const activeCapabilities =
      await input.workerCoordination.listActiveWorkerCapabilities({
        staleBefore,
      });
    const missing = fleetMissingRequiredCapabilities(
      required,
      activeCapabilities,
    );
    if (missing.length === 0) return;
    await starvationAlerter.alert({
      cause: 'no_eligible_recoverer',
      appId: turn.appId,
      key: turn.id,
      runId: turn.runId,
      requiredCapabilities: required,
      missingCapabilities: missing,
      ageSeconds: Math.max(
        0,
        Math.floor((input.nowMs() - Date.parse(turn.updatedAt)) / 1000),
      ),
    });
  };
  return {
    isEligibleToRecoverLiveTurn,
    alertNoEligibleLiveTurnRecoverer: starvationAlerter
      ? alertNoEligibleLiveTurnRecoverer
      : undefined,
  };
}
