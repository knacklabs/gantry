import path from 'node:path';

import type { RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import { ArtifactIntegrityError } from '../domain/ports/skill-artifact-store.js';
import type { SkillArtifactMaterializer } from '../domain/ports/skill-artifact-store.js';
import type { ToolchainArtifactMaterializer } from '../domain/ports/toolchain-artifact-store.js';
import type { WorkerRegistryRepository } from '../domain/ports/worker-coordination.js';
import { readImageCapabilityInventory } from '../shared/worker-image-inventory.js';
import type { ManifestWakeupSource } from './toolchain-manifest-listener.js';

/** Capability id a worker advertises for an activated skill artifact. */
export function skillCapabilityId(skillId: string): string {
  return `skill:${skillId}`;
}

/** Capability id a worker advertises for an activated toolchain artifact. */
export function toolchainCapabilityId(manifestHash: string): string {
  return `toolchain:${manifestHash}`;
}

export interface ArtifactIntegrityAuditEvent {
  appId: string;
  kind: 'skill' | 'toolchain';
  capabilityId: string;
  storageRef: string;
  expectedContentHash: string;
  actualContentHash: string;
  quarantinePath: string;
}

export interface WorkerCapabilityReconcilerDeps {
  appId: string;
  workerInstanceId: string;
  runtimeDependencies: RuntimeDependencyRepository;
  skills: SkillCatalogRepository;
  toolchainMaterializer: ToolchainArtifactMaterializer;
  skillMaterializer: SkillArtifactMaterializer;
  workerRegistry: WorkerRegistryRepository;
  wakeupSource: ManifestWakeupSource;
  /** Local root for activated artifacts and quarantine. */
  localRoot: string;
  pollIntervalMs?: number;
  imageInventory?: () => string[];
  onIntegrityError?: (event: ArtifactIntegrityAuditEvent) => void;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

interface ActivatedArtifact {
  capabilityId: string;
  contentHash: string;
}

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
  private readonly activated = new Map<string, ActivatedArtifact>();
  private unsubscribe: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  private stopped = false;

  constructor(private readonly deps: WorkerCapabilityReconcilerDeps) {}

  start(): void {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.deps.wakeupSource.subscribe(() => this.wake());
    const setIntervalFn = this.deps.setIntervalFn ?? setInterval;
    const timer = setIntervalFn(
      () => this.wake(),
      this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
    (
      timer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
    this.pollTimer = timer;
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      (this.deps.clearIntervalFn ?? clearInterval)(this.pollTimer);
      this.pollTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.inFlight?.catch(() => {});
    await this.deps.wakeupSource.close();
  }

  /** Trigger a reconcile, coalescing overlapping wakeups into one in-flight run. */
  wake(): void {
    if (this.stopped) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    this.inFlight = this.reconcile()
      .catch((err) =>
        this.deps.logWarn?.({ err }, 'Worker capability reconcile failed'),
      )
      .finally(() => {
        this.inFlight = null;
        if (this.rerunRequested && !this.stopped) {
          this.rerunRequested = false;
          this.wake();
        }
      });
  }

  /** Run one full reconcile pass. Exposed for tests that await a single pass. */
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    await this.reconcileToolchains();
    await this.reconcileSkills();
    await this.advertise();
  }

  private async reconcileToolchains(): Promise<void> {
    const rows = await this.deps.runtimeDependencies.listRuntimeDependencies({
      appId: this.deps.appId,
      statuses: ['uploaded', 'activated'],
    });
    for (const row of rows) {
      const artifact = row.artifact;
      if (!artifact) continue;
      const capabilityId = toolchainCapabilityId(row.manifestHash);
      const already = this.activated.get(capabilityId);
      if (already?.contentHash === artifact.contentHash) continue;
      try {
        await this.deps.toolchainMaterializer.materializeToolchainArtifact({
          storageRef: artifact.storageRef,
          expectedContentHash: artifact.contentHash,
          targetDir: path.join(
            this.deps.localRoot,
            'toolchains',
            sanitize(row.manifestHash),
          ),
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
      } catch (err) {
        this.handleIntegrity(err, {
          appId: this.deps.appId,
          kind: 'toolchain',
          capabilityId,
          storageRef: artifact.storageRef,
        });
      }
    }
  }

  private async reconcileSkills(): Promise<void> {
    const skills = await this.deps.skills.listSkills({
      appId: this.deps.appId as never,
      statuses: ['installed'],
    });
    for (const skill of skills) {
      const storage = skill.storage;
      if (!storage || storage.storageType !== 'object-store') continue;
      const capabilityId = skillCapabilityId(skill.id);
      const already = this.activated.get(capabilityId);
      if (already?.contentHash === storage.contentHash) continue;
      try {
        await this.deps.skillMaterializer.materializeSkillArtifact({
          storageRef: storage.storageRef,
          expectedContentHash: storage.contentHash,
          targetDir: path.join(
            this.deps.localRoot,
            'skills',
            sanitize(skill.id),
          ),
          quarantineDir: path.join(this.deps.localRoot, 'quarantine'),
        });
        this.activated.set(capabilityId, {
          capabilityId,
          contentHash: storage.contentHash,
        });
      } catch (err) {
        this.handleIntegrity(err, {
          appId: this.deps.appId,
          kind: 'skill',
          capabilityId,
          storageRef: storage.storageRef,
        });
      }
    }
  }

  private async advertise(): Promise<void> {
    const inventory =
      this.deps.imageInventory?.() ?? readImageCapabilityInventory() ?? [];
    const advertised = new Set<string>(inventory);
    for (const entry of this.activated.values()) {
      advertised.add(entry.capabilityId);
    }
    const ok = await this.deps.workerRegistry.advertiseWorkerCapabilities({
      id: this.deps.workerInstanceId,
      capabilities: [...advertised],
    });
    if (!ok) {
      this.deps.logWarn?.(
        { workerInstanceId: this.deps.workerInstanceId },
        'Worker instance row missing while advertising capabilities',
      );
    }
  }

  private handleIntegrity(
    err: unknown,
    base: {
      appId: string;
      kind: 'skill' | 'toolchain';
      capabilityId: string;
      storageRef: string;
    },
  ): void {
    if (err instanceof ArtifactIntegrityError) {
      // Quarantined by the materializer; do NOT advertise this capability.
      this.activated.delete(base.capabilityId);
      this.deps.onIntegrityError?.({
        ...base,
        expectedContentHash: err.expectedContentHash,
        actualContentHash: err.actualContentHash,
        quarantinePath: err.quarantinePath,
      });
      this.deps.logWarn?.(
        { ...base, quarantinePath: err.quarantinePath },
        'Artifact integrity check failed; quarantined and not advertised',
      );
      return;
    }
    this.deps.logWarn?.(
      { err, ...base },
      'Failed to materialize artifact; capability not advertised this pass',
    );
  }
}

function sanitize(value: string): string {
  return (
    value
      .replace(/^sha256:/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^\.+/, '')
      .slice(0, 120) || 'artifact'
  );
}
