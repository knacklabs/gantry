import * as p from '@clack/prompts';
import fs from 'node:fs';
import path from 'node:path';

import {
  closeRuntimeStorage,
  getRuntimeStorage,
  initializeRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import {
  ARTIFACTS_DIR,
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
} from '../config/index.js';
import type { AppId } from '../domain/app/app.js';
import {
  bakeReapStalenessMs,
  resetToolchainBakeForRequeue,
} from '../jobs/toolchain-bake-reaper.js';
import { ToolchainBakeSender } from '../jobs/toolchain-bake-queue.js';
import { PostgresToolchainManifestNotifier } from '../jobs/toolchain-manifest-notify.js';
import { runtimePgBossSchema } from '../infrastructure/pgboss/pgboss-schema.js';

function usage(): string {
  return [
    'Usage:',
    '  gantry artifacts quarantine list',
    '  gantry artifacts quarantine purge',
    '  gantry artifacts quarantine rebake <manifestHash>',
  ].join('\n');
}

/** Quarantine directory the artifact materializers write to (localRoot/quarantine). */
function quarantineDir(): string {
  return path.join(ARTIFACTS_DIR, 'quarantine');
}

export async function runArtifactsCommand(args: string[]): Promise<number> {
  const [group, subcommand, ...rest] = args;
  if (group !== 'quarantine' || !subcommand) {
    console.log(usage());
    return 1;
  }

  if (subcommand === 'list') {
    return listQuarantine();
  }
  if (subcommand === 'purge') {
    return purgeQuarantine();
  }
  if (subcommand === 'rebake') {
    return rebake(rest[0]);
  }

  console.log(usage());
  return 1;
}

function listQuarantine(): number {
  const dir = quarantineDir();
  if (!fs.existsSync(dir)) {
    p.note('Quarantine directory is empty.', 'Artifact Quarantine');
    return 0;
  }
  const entries = fs.readdirSync(dir);
  if (entries.length === 0) {
    p.note('Quarantine directory is empty.', 'Artifact Quarantine');
    return 0;
  }
  p.note(entries.join('\n'), 'Artifact Quarantine');
  return 0;
}

function purgeQuarantine(): number {
  const dir = quarantineDir();
  if (!fs.existsSync(dir)) {
    p.log.success('Quarantine directory already empty.');
    return 0;
  }
  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    removed += 1;
  }
  p.log.success(`Purged ${removed} quarantined artifact(s).`);
  return 0;
}

async function rebake(manifestHash: string | undefined): Promise<number> {
  if (!manifestHash) {
    p.log.error('Usage: gantry artifacts quarantine rebake <manifestHash>');
    return 1;
  }
  if (!STORAGE_POSTGRES_URL) {
    p.log.error('Postgres is required to rebake a toolchain manifest.');
    return 1;
  }

  await initializeRuntimeStorage();
  const queue = new ToolchainBakeSender({
    connectionString: STORAGE_POSTGRES_URL,
    schema: runtimePgBossSchema(),
    applicationName: `gantry-${STORAGE_POSTGRES_SCHEMA}-rebake`,
  });
  try {
    const storage = getRuntimeStorage();
    const repository = storage.repositories.runtimeDependencies;
    const row = await repository.getRuntimeDependencyByManifestHash({
      appId: 'default' as AppId,
      manifestHash,
    });
    if (!row) {
      p.log.error(`No toolchain manifest found for hash ${manifestHash}.`);
      return 1;
    }
    await queue.start();
    // Single guarded reset path shared with the bake reaper: a quarantined
    // (uploaded|activated) or failed manifest resets to queued and re-enqueues;
    // a stale `baking` row is reclaimed; a fresh `baking` row is in flight and
    // is never clobbered from the CLI.
    const outcome = await resetToolchainBakeForRequeue(
      {
        runtimeDependencies: repository,
        queue,
        notifier: new PostgresToolchainManifestNotifier(storage.service.pool),
      },
      {
        dependency: row,
        fromStatuses: ['failed', 'uploaded', 'activated', 'baking', 'queued'],
        stalenessMs: bakeReapStalenessMs(),
      },
    );
    if (outcome === 'in_flight') {
      p.log.error(
        `Manifest ${manifestHash} is baking right now (started ${row.updatedAt}). Wait for it to finish or fail, then rebake.`,
      );
      return 1;
    }
    if (outcome === 'lost_race') {
      p.log.error(
        `Manifest ${manifestHash} changed concurrently; re-run the command to see its current status.`,
      );
      return 1;
    }
    p.log.success(
      `Re-queued bake for ${manifestHash}. A fleet worker will rebuild and re-verify it.`,
    );
    return 0;
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
