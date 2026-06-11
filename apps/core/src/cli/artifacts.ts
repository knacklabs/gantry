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
import { enqueueToolchainBake } from '../jobs/toolchain-bake-enqueue.js';
import { ToolchainBakeSender } from '../jobs/toolchain-bake-queue.js';

const DEFAULT_BAKE_REGISTRY = 'https://registry.npmjs.org/';

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
    return group ? 1 : 1;
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
    schema: 'pgboss',
    applicationName: `gantry-${STORAGE_POSTGRES_SCHEMA}-rebake`,
  });
  try {
    const repository = getRuntimeStorage().repositories.runtimeDependencies;
    const row = await repository.getRuntimeDependencyByManifestHash({
      appId: 'default' as AppId,
      manifestHash,
    });
    if (!row) {
      p.log.error(`No toolchain manifest found for hash ${manifestHash}.`);
      return 1;
    }
    // Reset a failed manifest to queued so enqueue re-baths it; an already
    // healthy manifest is re-enqueued idempotently onto the same hash.
    await repository.updateRuntimeDependencyStatus({
      id: row.id,
      status: 'queued',
      failureReason: null,
    });
    await queue.start();
    const result = await enqueueToolchainBake(
      {
        runtimeDependencies: repository,
        queue,
        registry: DEFAULT_BAKE_REGISTRY,
      },
      { appId: 'default' as AppId, packages: row.requestedPackages },
    );
    p.log.success(
      `Re-queued bake for ${manifestHash} (${result.status}). A fleet worker will rebuild and re-verify it.`,
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
