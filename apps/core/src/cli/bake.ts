import * as p from '@clack/prompts';

import {
  closeRuntimeStorage,
  getRuntimeStorage,
  initializeRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import {
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
} from '../config/index.js';
import type { AppId } from '../domain/app/app.js';
import type { RuntimeDependency } from '../domain/ports/fleet-capability-state.js';
import {
  bakeReapStalenessMs,
  resetToolchainBakeForRequeue,
} from '../jobs/toolchain-bake-reaper.js';
import { ToolchainBakeSender } from '../jobs/toolchain-bake-queue.js';
import { PostgresToolchainManifestNotifier } from '../jobs/toolchain-manifest-notify.js';
import { nowMs } from '../shared/time/datetime.js';

function usage(): string {
  return [
    'Usage:',
    '  gantry bake status',
    '  gantry bake rebake <manifestHash>',
  ].join('\n');
}

function ageLabel(iso: string): string {
  const ms = nowMs() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export async function runBakeCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'status') {
    return bakeStatus();
  }
  if (subcommand === 'rebake') {
    return bakeRebake(rest[0]);
  }
  console.log(usage());
  return 1;
}

async function bakeStatus(): Promise<number> {
  await initializeRuntimeStorage();
  try {
    const rows =
      await getRuntimeStorage().repositories.runtimeDependencies.listRuntimeDependencies(
        { appId: 'default' as AppId },
      );
    if (rows.length === 0) {
      p.note('No toolchain bake manifests recorded.', 'Bake Status');
      return 0;
    }
    const lines = rows.map(
      (row) =>
        `${row.manifestHash.slice(0, 16)}  status=${row.status}` +
        `  age=${ageLabel(row.updatedAt)}` +
        (row.failureReason ? `  failure: ${row.failureReason}` : ''),
    );
    p.note(lines.join('\n'), 'Bake Status');
    return 0;
  } finally {
    await closeRuntimeStorage();
  }
}

/**
 * Operator remedy for a stuck bake: CAS-reset a failed or STALE baking manifest
 * back to queued and re-enqueue it, through the same guarded reset path the
 * bake reaper uses (one code path — the in-flight guard cannot be bypassed). A
 * fresh `baking` row is in flight and is rejected; uploaded/activated manifests
 * are rebaked with `gantry artifacts quarantine rebake` instead.
 */
async function bakeRebake(
  manifestHashInput: string | undefined,
): Promise<number> {
  if (!manifestHashInput) {
    p.log.error('Usage: gantry bake rebake <manifestHash>');
    return 1;
  }
  if (!STORAGE_POSTGRES_URL) {
    p.log.error('Postgres is required to rebake a toolchain manifest.');
    return 1;
  }
  await initializeRuntimeStorage();
  const queue = new ToolchainBakeSender({
    connectionString: STORAGE_POSTGRES_URL,
    schema: 'pgboss',
    applicationName: `gantry-${STORAGE_POSTGRES_SCHEMA}-bake-rebake`,
  });
  try {
    const storage = getRuntimeStorage();
    const repository = storage.repositories.runtimeDependencies;
    const row = await findManifest(repository, manifestHashInput);
    if (typeof row === 'number') return row;
    await queue.start();
    const outcome = await resetToolchainBakeForRequeue(
      {
        runtimeDependencies: repository,
        queue,
        notifier: new PostgresToolchainManifestNotifier(storage.service.pool),
      },
      {
        dependency: row,
        fromStatuses: ['failed', 'baking'],
        stalenessMs: bakeReapStalenessMs(),
      },
    );
    switch (outcome) {
      case 'requeued':
        p.log.success(
          `Re-queued bake for ${row.manifestHash}. A fleet worker will rebuild it.`,
        );
        return 0;
      case 'in_flight':
        p.log.error(
          `Manifest ${row.manifestHash} is baking right now (started ${row.updatedAt}). Wait for it to finish or fail, then rebake.`,
        );
        return 1;
      case 'lost_race':
        p.log.error(
          `Manifest ${row.manifestHash} changed concurrently; re-run \`gantry bake status\` to see where it landed.`,
        );
        return 1;
      case 'not_resettable':
        p.log.error(
          `Manifest ${row.manifestHash} is ${row.status}; bake rebake only resets failed or stale baking manifests. For a quarantined uploaded/activated artifact use: gantry artifacts quarantine rebake ${row.manifestHash}`,
        );
        return 1;
    }
  } catch (err) {
    p.log.error(
      `Rebake failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    await queue.stop();
    await closeRuntimeStorage();
  }
}

/**
 * Resolve an exact manifest hash or a unique prefix (the status listing
 * truncates hashes to 16 chars). Returns an exit code on lookup failure.
 */
async function findManifest(
  repository: {
    getRuntimeDependencyByManifestHash(input: {
      appId: AppId;
      manifestHash: string;
    }): Promise<RuntimeDependency | null>;
    listRuntimeDependencies(input: {
      appId: AppId;
    }): Promise<RuntimeDependency[]>;
  },
  manifestHashInput: string,
): Promise<RuntimeDependency | number> {
  const exact = await repository.getRuntimeDependencyByManifestHash({
    appId: 'default' as AppId,
    manifestHash: manifestHashInput,
  });
  if (exact) return exact;
  const rows = await repository.listRuntimeDependencies({
    appId: 'default' as AppId,
  });
  const needle = manifestHashInput.replace(/^sha256:/, '');
  const matches = rows.filter((row) =>
    row.manifestHash.replace(/^sha256:/, '').startsWith(needle),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    p.log.error(
      `Manifest hash prefix ${manifestHashInput} is ambiguous: ${matches
        .map((row) => row.manifestHash.slice(0, 24))
        .join(', ')}`,
    );
    return 1;
  }
  p.log.error(`No toolchain manifest found for hash ${manifestHashInput}.`);
  return 1;
}
