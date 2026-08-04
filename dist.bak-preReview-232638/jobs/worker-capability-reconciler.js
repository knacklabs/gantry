import path from 'node:path';
import { ArtifactIntegrityError } from '../domain/ports/skill-artifact-store.js';
import { readImageCapabilityInventory } from '../shared/worker-image-inventory.js';
/** Capability id a worker advertises for an activated skill artifact. */
export function skillCapabilityId(skillId) {
    return `skill:${skillId}`;
}
/** Capability id a worker advertises for an activated toolchain artifact. */
export function toolchainCapabilityId(manifestHash) {
    return `toolchain:${manifestHash}`;
}
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/**
 * Worker-side capability reconciler (fleet mode only). On a manifest NOTIFY or
 * the interval poll it lists uploaded/activated toolchains and skills with an
 * object-store artifact for the app, fetches + sha256-verifies + atomically
 * activates any it is missing or whose hash changed, and advertises the
 * satisfied capability ids in `worker_instances.capabilities_json` (merged with
 * the immutable image inventory). An integrity failure quarantines the artifact
 * (handled by the materializer), emits an audit event, and is NOT advertised.
 *
 * Started only in fleet mode; workstation never runs it (local installs are
 * unchanged). All background work is stoppable via {@link stop}.
 */
export class WorkerCapabilityReconciler {
    deps;
    activated = new Map();
    unsubscribe = null;
    pollTimer = null;
    inFlight = null;
    rerunRequested = false;
    stopped = false;
    constructor(deps) {
        this.deps = deps;
    }
    start() {
        if (this.unsubscribe || this.stopped)
            return;
        this.unsubscribe = this.deps.wakeupSource.subscribe(() => this.wake());
        const setIntervalFn = this.deps.setIntervalFn ?? setInterval;
        const timer = setIntervalFn(() => this.wake(), this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        timer.unref?.();
        this.pollTimer = timer;
        this.wake();
    }
    async stop() {
        this.stopped = true;
        if (this.pollTimer) {
            (this.deps.clearIntervalFn ?? clearInterval)(this.pollTimer);
            this.pollTimer = null;
        }
        this.unsubscribe?.();
        this.unsubscribe = null;
        await this.inFlight?.catch(() => { });
        await this.deps.wakeupSource.close();
    }
    /** Trigger a reconcile, coalescing overlapping wakeups into one in-flight run. */
    wake() {
        if (this.stopped)
            return;
        if (this.inFlight) {
            this.rerunRequested = true;
            return;
        }
        this.inFlight = this.reconcile()
            .catch((err) => this.deps.logWarn?.({ err }, 'Worker capability reconcile failed'))
            .finally(() => {
            this.inFlight = null;
            if (this.rerunRequested && !this.stopped) {
                this.rerunRequested = false;
                this.wake();
            }
        });
    }
    /** Run one full reconcile pass. Exposed for tests that await a single pass. */
    async reconcile() {
        if (this.stopped)
            return;
        await this.reconcileToolchains();
        await this.reconcileSkills();
        await this.advertise();
    }
    async reconcileToolchains() {
        const rows = await this.deps.runtimeDependencies.listRuntimeDependencies({
            appId: this.deps.appId,
            statuses: ['uploaded', 'activated'],
        });
        for (const row of rows) {
            const artifact = row.artifact;
            if (!artifact)
                continue;
            const capabilityId = toolchainCapabilityId(row.manifestHash);
            const already = this.activated.get(capabilityId);
            if (already?.contentHash === artifact.contentHash)
                continue;
            try {
                await this.deps.toolchainMaterializer.materializeToolchainArtifact({
                    storageRef: artifact.storageRef,
                    expectedContentHash: artifact.contentHash,
                    targetDir: path.join(this.deps.localRoot, 'toolchains', sanitize(row.manifestHash)),
                    quarantineDir: path.join(this.deps.localRoot, 'quarantine'),
                });
                this.activated.set(capabilityId, {
                    capabilityId,
                    contentHash: artifact.contentHash,
                });
                if (row.status === 'uploaded') {
                    // Flip the row to activated on the first worker that activates it.
                    await this.deps.runtimeDependencies.updateRuntimeDependencyStatus({
                        id: row.id,
                        status: 'activated',
                        fromStatus: 'uploaded',
                    });
                }
            }
            catch (err) {
                this.handleIntegrity(err, {
                    appId: this.deps.appId,
                    kind: 'toolchain',
                    capabilityId,
                    storageRef: artifact.storageRef,
                });
            }
        }
    }
    async reconcileSkills() {
        const skills = await this.deps.skills.listSkills({
            appId: this.deps.appId,
            statuses: ['installed'],
        });
        for (const skill of skills) {
            const storage = skill.storage;
            if (!storage || storage.storageType !== 'object-store')
                continue;
            const capabilityId = skillCapabilityId(skill.id);
            const already = this.activated.get(capabilityId);
            if (already?.contentHash === storage.contentHash)
                continue;
            try {
                await this.deps.skillMaterializer.materializeSkillArtifact({
                    storageRef: storage.storageRef,
                    expectedContentHash: storage.contentHash,
                    targetDir: path.join(this.deps.localRoot, 'skills', sanitize(skill.id)),
                    quarantineDir: path.join(this.deps.localRoot, 'quarantine'),
                });
                this.activated.set(capabilityId, {
                    capabilityId,
                    contentHash: storage.contentHash,
                });
            }
            catch (err) {
                this.handleIntegrity(err, {
                    appId: this.deps.appId,
                    kind: 'skill',
                    capabilityId,
                    storageRef: storage.storageRef,
                });
            }
        }
    }
    async advertise() {
        const inventory = this.deps.imageInventory?.() ?? readImageCapabilityInventory() ?? [];
        const advertised = new Set(inventory);
        for (const entry of this.activated.values()) {
            advertised.add(entry.capabilityId);
        }
        const ok = await this.deps.workerRegistry.advertiseWorkerCapabilities({
            id: this.deps.workerInstanceId,
            capabilities: [...advertised],
        });
        if (!ok) {
            this.deps.logWarn?.({ workerInstanceId: this.deps.workerInstanceId }, 'Worker instance row missing while advertising capabilities');
        }
    }
    handleIntegrity(err, base) {
        if (err instanceof ArtifactIntegrityError) {
            // Quarantined by the materializer; do NOT advertise this capability.
            this.activated.delete(base.capabilityId);
            this.deps.onIntegrityError?.({
                ...base,
                expectedContentHash: err.expectedContentHash,
                actualContentHash: err.actualContentHash,
                quarantinePath: err.quarantinePath,
            });
            this.deps.logWarn?.({ ...base, quarantinePath: err.quarantinePath }, 'Artifact integrity check failed; quarantined and not advertised');
            return;
        }
        this.deps.logWarn?.({ err, ...base }, 'Failed to materialize artifact; capability not advertised this pass');
    }
}
function sanitize(value) {
    return (value
        .replace(/^sha256:/, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^\.+/, '')
        .slice(0, 120) || 'artifact');
}
