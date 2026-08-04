import { randomUUID } from 'node:crypto';
import { nowMs, toIso } from '../shared/time/datetime.js';
import { processLiveAdmissionWorkItem, } from './message-loop.js';
const DEFAULT_CLAIM_LIMIT = 25;
const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_MAX_BATCHES_PER_WAKE = 10;
const DEFAULT_MAX_RETRY_COUNT = 5;
function deferReasonForResult(result) {
    return result;
}
function deferDelayMs(result) {
    if (result === 'queued_capacity')
        return 1_000;
    if (result === 'listener_degraded')
        return 3_000;
    return 5_000;
}
export function startLiveAdmissionWorkLoop(input) {
    const claimLimit = input.claimLimit ?? DEFAULT_CLAIM_LIMIT;
    const claimTtlMs = input.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    const claimRenewalIntervalMs = input.claimRenewalIntervalMs !== undefined
        ? Math.max(1, input.claimRenewalIntervalMs)
        : Math.max(1_000, Math.floor(claimTtlMs / 3));
    const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
    const maxBatchesPerWake = input.maxBatchesPerWake ?? DEFAULT_MAX_BATCHES_PER_WAKE;
    const maxRetryCount = input.maxRetryCount ?? DEFAULT_MAX_RETRY_COUNT;
    let stopped = false;
    let cancelDelay;
    const inFlightClaims = new Map();
    const deferClaim = async (itemId, claimToken, result) => {
        const reason = result === 'retry' ? 'retry' : deferReasonForResult(result);
        const ok = await input.liveAdmissions.deferLiveAdmissionWorkItem({
            id: itemId,
            claimToken,
            workerInstanceId: input.workerInstanceId,
            reason,
            deferUntil: toIso(nowMs() + deferDelayMs(result)),
            countFailure: result !== 'queued_capacity',
        });
        if (!ok) {
            input.warn({ itemId, reason }, 'Failed to defer live admission work item claim');
        }
    };
    const failClaim = async (itemId, claimToken, reason) => {
        const ok = await input.liveAdmissions.settleLiveAdmissionWorkItem({
            id: itemId,
            claimToken,
            workerInstanceId: input.workerInstanceId,
            state: 'failed',
        });
        if (!ok) {
            input.warn({ itemId, reason }, 'Failed to dead-letter live admission work item claim');
        }
    };
    const shouldFailClaim = (itemFailureCount, result) => result !== 'queued_capacity' && itemFailureCount + 1 >= maxRetryCount;
    const renewClaim = async (itemId, claimToken) => input.liveAdmissions.renewLiveAdmissionWorkItemClaim({
        id: itemId,
        claimToken,
        workerInstanceId: input.workerInstanceId,
        claimExpiresAt: toIso(nowMs() + claimTtlMs),
    });
    const releaseInFlightClaims = async () => {
        const claims = [...inFlightClaims.entries()];
        inFlightClaims.clear();
        await Promise.all(claims.map(([itemId, { claimToken }]) => input.liveAdmissions
            .deferLiveAdmissionWorkItem({
            id: itemId,
            claimToken,
            workerInstanceId: input.workerInstanceId,
            reason: 'retry',
            deferUntil: toIso(nowMs()),
        })
            .then((ok) => {
            if (!ok) {
                input.warn({ itemId }, 'Failed to release live admission claim during shutdown');
            }
        })
            .catch((err) => input.warn({ err, itemId }, 'Failed to release live admission claim during shutdown'))));
    };
    const processWithClaimRenewal = async (item, claimToken) => {
        const itemId = item.id;
        let claimLost = false;
        let stoppedRenewing = false;
        let timer;
        let renewalInFlight;
        const scheduleRenewal = () => {
            timer = setTimeout(() => {
                timer = undefined;
                renewalInFlight = (async () => {
                    try {
                        const ok = await renewClaim(itemId, claimToken);
                        if (!ok) {
                            claimLost = true;
                            input.warn({ itemId }, 'Live admission work item claim was lost during processing');
                            return;
                        }
                    }
                    catch (err) {
                        input.warn({ err, itemId }, 'Failed to renew live admission work item claim during processing');
                    }
                    if (!stoppedRenewing)
                        scheduleRenewal();
                })();
                void renewalInFlight;
            }, claimRenewalIntervalMs);
        };
        scheduleRenewal();
        let result;
        try {
            result = await processLiveAdmissionWorkItem(input.messageLoopDeps, item);
        }
        finally {
            stoppedRenewing = true;
            if (timer)
                clearTimeout(timer);
            await renewalInFlight;
        }
        if (result === undefined) {
            throw new Error('Live admission processing finished without a result.');
        }
        return { result, claimLost };
    };
    const drainOnce = async () => {
        for (let batch = 0; batch < maxBatchesPerWake && !stopped; batch++) {
            const claimToken = `live-admission:${input.workerInstanceId}:${randomUUID()}`;
            const claimed = await input.liveAdmissions.claimLiveAdmissionWorkItems({
                appId: input.appId,
                workerInstanceId: input.workerInstanceId,
                claimToken,
                claimExpiresAt: toIso(nowMs() + claimTtlMs),
                limit: claimLimit,
            });
            if (claimed.length === 0)
                return;
            for (const item of claimed) {
                inFlightClaims.set(item.id, { claimToken });
            }
            for (const item of claimed) {
                if (stopped) {
                    await releaseInFlightClaims();
                    return;
                }
                if (!(await renewClaim(item.id, claimToken))) {
                    inFlightClaims.delete(item.id);
                    input.warn({ itemId: item.id }, 'Live admission work item claim was lost before processing');
                    continue;
                }
                inFlightClaims.delete(item.id);
                try {
                    const { result, claimLost } = await processWithClaimRenewal(item, claimToken);
                    if (claimLost)
                        continue;
                    if (result === 'completed') {
                        const ok = await input.liveAdmissions.settleLiveAdmissionWorkItem({
                            id: item.id,
                            claimToken,
                            workerInstanceId: input.workerInstanceId,
                            state: 'completed',
                        });
                        if (!ok) {
                            input.warn({ itemId: item.id }, 'Failed to settle live admission work item claim');
                        }
                        continue;
                    }
                    if (shouldFailClaim(item.failureCount, result)) {
                        await failClaim(item.id, claimToken, result);
                        continue;
                    }
                    await deferClaim(item.id, claimToken, result);
                }
                catch (err) {
                    input.warn({ err, itemId: item.id }, 'Live admission work item processing failed; deferring retry');
                    if (shouldFailClaim(item.failureCount, 'retry')) {
                        await failClaim(item.id, claimToken, 'retry');
                    }
                    else {
                        await deferClaim(item.id, claimToken, 'retry');
                    }
                }
                finally {
                    inFlightClaims.delete(item.id);
                }
            }
            if (claimed.length < claimLimit)
                return;
        }
    };
    const done = (async () => {
        while (!stopped) {
            try {
                await drainOnce();
            }
            catch (err) {
                input.warn({ err }, 'Live admission work loop failed to claim durable work items');
            }
            if (stopped)
                break;
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    cancelDelay = undefined;
                    resolve();
                }, intervalMs);
                cancelDelay = () => {
                    cancelDelay = undefined;
                    clearTimeout(timer);
                    resolve();
                };
            });
        }
    })();
    const stop = async (options) => {
        stopped = true;
        cancelDelay?.();
        const deadline = options?.drainDeadlineMs;
        if (deadline === undefined)
            return;
        let timedOut = false;
        let timer;
        try {
            await Promise.race([
                done,
                new Promise((resolve) => {
                    timer = setTimeout(() => {
                        timedOut = true;
                        resolve();
                    }, Math.max(0, deadline));
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
        if (timedOut) {
            await releaseInFlightClaims();
        }
    };
    return {
        stop,
        trigger: () => {
            cancelDelay?.();
        },
        done,
    };
}
