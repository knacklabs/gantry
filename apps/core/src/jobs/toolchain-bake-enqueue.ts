import { randomUUID } from 'node:crypto';

import type {
  RuntimeDependency,
  RuntimeDependencyRepository,
} from '../domain/ports/fleet-capability-state.js';
import { normalizeToolchainManifest } from './toolchain-bake-manifest.js';

export interface ToolchainBakeQueuePort {
  /** Enqueue a bake for a runtime_dependencies row (pg-boss in production). */
  enqueueBake(input: {
    dependencyId: string;
    manifestHash: string;
  }): Promise<void>;
}

export interface EnqueueToolchainBakeDeps {
  runtimeDependencies: RuntimeDependencyRepository;
  queue: ToolchainBakeQueuePort;
  registry: string;
}

export type EnqueueToolchainBakeResult =
  | { status: 'enqueued'; dependency: RuntimeDependency; deduplicated: false }
  | {
      status: 'already_present';
      dependency: RuntimeDependency;
      deduplicated: true;
    };

/**
 * Idempotent toolchain bake enqueue. Validates the npm manifest (npm-only;
 * system packages rejected with the ADR-2 error), computes the manifest hash,
 * and creates the runtime_dependencies row. Because the row is idempotent on
 * (appId, manifestHash), a concurrent or repeated request collapses onto the
 * existing row: a non-`failed` existing row short-circuits (no duplicate bake);
 * a previously-failed row is re-enqueued so an operator can retry by re-approving.
 */
export async function enqueueToolchainBake(
  deps: EnqueueToolchainBakeDeps,
  input: {
    appId: string;
    packages: string[];
    requestedByAgentId?: string | null;
    approvedByConversationId?: string | null;
    approvedAt?: string | null;
  },
): Promise<EnqueueToolchainBakeResult> {
  const manifest = normalizeToolchainManifest({
    packages: input.packages,
    registry: deps.registry,
  });

  const existing =
    await deps.runtimeDependencies.getRuntimeDependencyByManifestHash({
      appId: input.appId,
      manifestHash: manifest.manifestHash,
    });
  if (existing && existing.status !== 'failed') {
    return {
      status: 'already_present',
      dependency: existing,
      deduplicated: true,
    };
  }

  if (existing && existing.status === 'failed') {
    // Re-approval of a previously failed manifest: reset to queued and re-enqueue.
    await deps.runtimeDependencies.updateRuntimeDependencyStatus({
      id: existing.id,
      status: 'queued',
      fromStatus: 'failed',
      failureReason: null,
    });
    const requeued =
      (await deps.runtimeDependencies.getRuntimeDependency(existing.id)) ??
      existing;
    await deps.queue.enqueueBake({
      dependencyId: requeued.id,
      manifestHash: manifest.manifestHash,
    });
    return { status: 'enqueued', dependency: requeued, deduplicated: false };
  }

  const dependency = await deps.runtimeDependencies.createRuntimeDependency({
    id: randomUUID(),
    appId: input.appId,
    manifestHash: manifest.manifestHash,
    requestedPackages: manifest.packages,
    requestedByAgentId: input.requestedByAgentId ?? null,
    approvedByConversationId: input.approvedByConversationId ?? null,
    approvedAt: input.approvedAt ?? null,
  });
  // createRuntimeDependency is itself idempotent: if another request won the
  // race, the returned row may already be past `queued` — only enqueue when we
  // observe the fresh queued row to avoid a duplicate bake send.
  if (dependency.status === 'queued') {
    await deps.queue.enqueueBake({
      dependencyId: dependency.id,
      manifestHash: manifest.manifestHash,
    });
    return { status: 'enqueued', dependency, deduplicated: false };
  }
  return { status: 'already_present', dependency, deduplicated: true };
}
