import { isWorkerEligibleForRequiredCapabilities, resolveRequiredCapabilities, } from '../../jobs/capability-eligibility.js';
import { CapabilityStarvationAlerter, fleetMissingRequiredCapabilities, } from '../../jobs/capability-starvation.js';
import { WORKER_STALE_AFTER_MS } from '../../shared/worker-heartbeat.js';
import { findConversationRouteForQueue, makeThreadQueueKey, } from '../../shared/thread-queue-key.js';
const UNRESOLVED_LIVE_TURN_OWNER_CAPABILITY = 'gantry:unresolved-live-turn-owner';
export function buildLiveTurnRecoveryCapabilityGate(input) {
    const starvationAlerter = input.publishRuntimeEvent
        ? new CapabilityStarvationAlerter({
            publishRuntimeEvent: input.publishRuntimeEvent,
            warn: input.warn,
        })
        : undefined;
    const requiredCapabilitiesForLiveTurn = async (turn) => {
        const pendingQueueJid = turn.pendingMessage &&
            typeof turn.pendingMessage === 'object' &&
            !Array.isArray(turn.pendingMessage) &&
            typeof turn.pendingMessage.queueJid === 'string'
            ? turn.pendingMessage.queueJid
            : undefined;
        const route = findConversationRouteForQueue(input.app.getConversationRoutes(), pendingQueueJid ?? makeThreadQueueKey(turn.conversationId, turn.threadId), (candidate) => input.agentIdForFolder(candidate.folder));
        const folder = route?.folder;
        if (!folder) {
            // ponytail: sentinel keeps fleet recovery fail-closed without widening
            // the capability-gate return type.
            return [UNRESOLVED_LIVE_TURN_OWNER_CAPABILITY];
        }
        return resolveRequiredCapabilities({
            deploymentMode: 'fleet',
            skills: input.getSkillRepository?.(),
            runtimeDependencies: input.getRuntimeDependencyRepository?.(),
        }, { appId: turn.appId, agentId: input.agentIdForFolder(folder) });
    };
    const isEligibleToRecoverLiveTurn = async (turn) => {
        if (input.getDeploymentMode() !== 'fleet')
            return true;
        if (!input.workerCoordination || !input.liveTurnLeaseDeps)
            return true;
        const required = await requiredCapabilitiesForLiveTurn(turn);
        if (required.length === 0)
            return true;
        const worker = await input.workerCoordination.getWorker(input.liveTurnLeaseDeps.workerInstanceId);
        if (!worker)
            return true;
        return isWorkerEligibleForRequiredCapabilities(required, worker.capabilities);
    };
    const alertNoEligibleLiveTurnRecoverer = async (turn) => {
        if (!input.workerCoordination || !starvationAlerter)
            return;
        const required = await requiredCapabilitiesForLiveTurn(turn);
        if (required.length === 0)
            return;
        const staleBefore = new Date(input.nowMs() - WORKER_STALE_AFTER_MS).toISOString();
        const activeCapabilities = await input.workerCoordination.listActiveWorkerCapabilities({
            staleBefore,
        });
        const missing = fleetMissingRequiredCapabilities(required, activeCapabilities);
        if (missing.length === 0)
            return;
        await starvationAlerter.alert({
            cause: 'no_eligible_recoverer',
            appId: turn.appId,
            key: turn.id,
            runId: turn.runId,
            requiredCapabilities: required,
            missingCapabilities: missing,
            ageSeconds: Math.max(0, Math.floor((input.nowMs() - Date.parse(turn.updatedAt)) / 1000)),
        });
    };
    return {
        isEligibleToRecoverLiveTurn,
        alertNoEligibleLiveTurnRecoverer: starvationAlerter
            ? alertNoEligibleLiveTurnRecoverer
            : undefined,
    };
}
