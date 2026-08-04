import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { DEFAULT_PROCESS_ROLE, } from '../app/bootstrap/roles/process-role.js';
import { WORKER_HEARTBEAT_INTERVAL_MS } from '../shared/worker-heartbeat.js';
import { readImageCapabilityInventory } from '../shared/worker-image-inventory.js';
let activeWorker = null;
export async function registerWorkerInstance(registry, options) {
    if (activeWorker)
        return activeWorker.id;
    const id = `worker-${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const bootNonce = randomUUID();
    await registry.registerWorker({
        id,
        bootNonce,
        imageDigest: process.env.GANTRY_IMAGE_DIGEST ?? null,
        version: process.env.npm_package_version ?? null,
        capabilities: readImageCapabilityInventory() ?? [],
        processRole: options?.processRole ?? DEFAULT_PROCESS_ROLE,
    });
    const heartbeatTimer = setInterval(() => {
        void registry
            .heartbeatWorker({ id })
            .catch((err) => options?.warn?.({ err, workerInstanceId: id }, 'Worker heartbeat failed'));
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    activeWorker = { id, bootNonce, registry, heartbeatTimer };
    return id;
}
export function requireWorkerInstanceId() {
    if (!activeWorker) {
        throw new Error('Worker instance is not registered');
    }
    return activeWorker.id;
}
export function currentWorkerInstanceId() {
    return activeWorker?.id ?? null;
}
export function stopWorkerHeartbeat() {
    if (!activeWorker)
        return;
    clearInterval(activeWorker.heartbeatTimer);
    activeWorker = null;
}
