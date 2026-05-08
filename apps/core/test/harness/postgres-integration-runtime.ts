import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CanonicalSessionOpsService } from '@core/adapters/storage/postgres/services/canonical-session-ops-service.js';
import { PostgresProviderArtifactStore } from '@core/adapters/artifacts/postgres/postgres-provider-artifact-store.js';
import { LocalSkillArtifactStore } from '@core/adapters/artifacts/skills/local-skill-artifact-store.js';
import {
  createPostgresDomainRepositories,
  type PostgresDomainRepositoryBundle,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import { PostgresRuntimeRepositoryBundle } from '@core/adapters/storage/postgres/schema/canonical-ops-repo.postgres.js';
import { PostgresControlPlaneRepository } from '@core/adapters/storage/postgres/repositories/control-plane-repository.postgres.js';
import { PostgresCanonicalSessionRepository } from '@core/adapters/storage/postgres/repositories/canonical-session-repository.postgres.js';
import { RuntimeEventExchange } from '@core/application/runtime-events/runtime-event-exchange.js';
import { PostgresRuntimeEventNotifier } from '@core/adapters/storage/postgres/runtime-event-notifier.postgres.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import type { StorageRuntime } from '@core/adapters/storage/postgres/factory.js';
import { loadSessionAppMemoryItems } from '@core/memory/app-memory-session-hydration.js';

export const POSTGRES_TEST_DATABASE_URL_ENV = 'MYCLAW_TEST_DATABASE_URL';
export const hasPostgresIntegrationDatabase = Boolean(
  process.env.MYCLAW_TEST_DATABASE_URL?.trim(),
);

function makeSchemaName(prefix = 'itest'): string {
  const base = `${prefix}_${process.pid}_${Date.now()}_${Math.floor(
    Math.random() * 1_000_000,
  )}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
  const schema = /^[a-z_]/.test(base) ? base : `s_${base}`;
  return schema.slice(0, 63);
}

export interface PostgresIntegrationRuntime {
  readonly schemaName: string;
  readonly artifactRoot: string;
  readonly service: PostgresStorageService;
  readonly storageRuntime: StorageRuntime;
  readonly ops: PostgresRuntimeRepositoryBundle;
  readonly control: PostgresControlPlaneRepository;
  readonly repositories: PostgresDomainRepositoryBundle;
  readonly canonicalSessionRepository: PostgresCanonicalSessionRepository;
  readonly sessionOps: CanonicalSessionOpsService;
  cleanup(): Promise<void>;
}

export async function createPostgresIntegrationRuntime(options?: {
  schemaPrefix?: string;
  artifactRootPrefix?: string;
}): Promise<PostgresIntegrationRuntime> {
  const databaseUrl = process.env.MYCLAW_TEST_DATABASE_URL;
  if (!databaseUrl?.trim()) {
    throw new Error(`${POSTGRES_TEST_DATABASE_URL_ENV} is required`);
  }

  const schemaName = makeSchemaName(options?.schemaPrefix);
  const service = new PostgresStorageService(databaseUrl, schemaName);
  await service.migrate();

  const repositories = createPostgresDomainRepositories(
    service.db,
    service.pool,
  );
  const control = new PostgresControlPlaneRepository(service.db);
  const runtimeEventNotifier = new PostgresRuntimeEventNotifier(service.pool);
  const runtimeEvents = new RuntimeEventExchange(
    repositories.runtimeEvents,
    runtimeEventNotifier,
  );
  const ops = new PostgresRuntimeRepositoryBundle(service.pool, service.db, {
    runtimeEvents,
    sessions: {
      loadAppMemoryItems: loadSessionAppMemoryItems,
    },
  });
  const canonicalSessionRepository = new PostgresCanonicalSessionRepository(
    service.db,
  );
  const sessionOps = new CanonicalSessionOpsService(canonicalSessionRepository);
  const artifactRoot = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      options?.artifactRootPrefix ?? `myclaw-pg-artifacts-${schemaName}-`,
    ),
  );
  const providerArtifacts = new PostgresProviderArtifactStore(service.db, {
    artifactRoot,
    defaultStorageType: 'local-filesystem',
  });
  const skillArtifacts = new LocalSkillArtifactStore(artifactRoot);
  const storageRuntime: StorageRuntime = {
    service,
    ops,
    control,
    repositories,
    runtimeEvents,
    runtimeEventNotifier,
    providerArtifacts,
    skillArtifacts,
  };

  return {
    schemaName,
    artifactRoot,
    service,
    storageRuntime,
    ops,
    control,
    repositories,
    canonicalSessionRepository,
    sessionOps,
    async cleanup() {
      try {
        await service.pool.query(
          `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
        );
      } finally {
        await service.close();
        fs.rmSync(artifactRoot, { recursive: true, force: true });
      }
    },
  };
}
