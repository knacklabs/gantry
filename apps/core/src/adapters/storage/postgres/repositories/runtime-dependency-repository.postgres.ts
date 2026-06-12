import { and, asc, desc, eq, inArray, lt, type SQL } from 'drizzle-orm';

import type {
  RuntimeDependency,
  RuntimeDependencyArtifact,
  RuntimeDependencyRepository,
  RuntimeDependencyStatus,
  StaleRuntimeDependencyLister,
  UpdateRuntimeDependencyStatusInput,
} from '../../../../domain/ports/fleet-capability-state.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

type RuntimeDependencyRow =
  typeof pgSchema.runtimeDependenciesPostgres.$inferSelect;

function toRuntimeDependency(row: RuntimeDependencyRow): RuntimeDependency {
  const artifact: RuntimeDependencyArtifact | null =
    row.storageType && row.storageRef && row.contentHash
      ? {
          storageType:
            row.storageType as RuntimeDependencyArtifact['storageType'],
          storageRef: row.storageRef,
          contentHash: row.contentHash,
          sizeBytes: row.sizeBytes ?? 0,
        }
      : null;
  return {
    id: row.id,
    appId: row.appId,
    manifestHash: row.manifestHash,
    requestedPackages: Array.isArray(row.requestedPackagesJson)
      ? (row.requestedPackagesJson as string[])
      : [],
    status: row.status as RuntimeDependencyStatus,
    artifact,
    failureReason: row.failureReason ?? null,
    requestedByAgentId: row.requestedByAgentId ?? null,
    approvedByConversationId: row.approvedByConversationId ?? null,
    approvedAt: row.approvedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresRuntimeDependencyRepository
  implements RuntimeDependencyRepository, StaleRuntimeDependencyLister
{
  constructor(private readonly db: CanonicalDb) {}

  async createRuntimeDependency(input: {
    id: string;
    appId: string;
    manifestHash: string;
    requestedPackages: string[];
    requestedByAgentId?: string | null;
    approvedByConversationId?: string | null;
    approvedAt?: string | null;
    now?: string;
  }): Promise<RuntimeDependency> {
    const now = input.now ?? nowIso();
    const table = pgSchema.runtimeDependenciesPostgres;
    await this.db
      .insert(table)
      .values({
        id: input.id,
        appId: input.appId,
        manifestHash: input.manifestHash,
        requestedPackagesJson: input.requestedPackages,
        status: 'queued',
        requestedByAgentId: input.requestedByAgentId ?? null,
        approvedByConversationId: input.approvedByConversationId ?? null,
        approvedAt: input.approvedAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [table.appId, table.manifestHash],
      });
    const existing = await this.getRuntimeDependencyByManifestHash({
      appId: input.appId,
      manifestHash: input.manifestHash,
    });
    if (!existing) {
      throw new Error(
        `Failed to persist runtime dependency for ${input.appId}/${input.manifestHash}`,
      );
    }
    return existing;
  }

  async getRuntimeDependency(id: string): Promise<RuntimeDependency | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.runtimeDependenciesPostgres)
      .where(eq(pgSchema.runtimeDependenciesPostgres.id, id))
      .limit(1);
    return rows[0] ? toRuntimeDependency(rows[0]) : null;
  }

  async getRuntimeDependencyByManifestHash(input: {
    appId: string;
    manifestHash: string;
  }): Promise<RuntimeDependency | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.runtimeDependenciesPostgres)
      .where(
        and(
          eq(pgSchema.runtimeDependenciesPostgres.appId, input.appId),
          eq(
            pgSchema.runtimeDependenciesPostgres.manifestHash,
            input.manifestHash,
          ),
        ),
      )
      .limit(1);
    return rows[0] ? toRuntimeDependency(rows[0]) : null;
  }

  async listRuntimeDependencies(input: {
    appId: string;
    statuses?: RuntimeDependencyStatus[];
  }): Promise<RuntimeDependency[]> {
    const filters: SQL[] = [
      eq(pgSchema.runtimeDependenciesPostgres.appId, input.appId),
    ];
    if (input.statuses?.length) {
      filters.push(
        inArray(pgSchema.runtimeDependenciesPostgres.status, input.statuses),
      );
    }
    const rows = await this.db
      .select()
      .from(pgSchema.runtimeDependenciesPostgres)
      .where(and(...filters))
      .orderBy(desc(pgSchema.runtimeDependenciesPostgres.updatedAt));
    return rows.map(toRuntimeDependency);
  }

  async listStaleRuntimeDependencies(input: {
    statuses: RuntimeDependencyStatus[];
    updatedBefore: string;
  }): Promise<RuntimeDependency[]> {
    if (input.statuses.length === 0) return [];
    const rows = await this.db
      .select()
      .from(pgSchema.runtimeDependenciesPostgres)
      .where(
        and(
          inArray(pgSchema.runtimeDependenciesPostgres.status, input.statuses),
          lt(
            pgSchema.runtimeDependenciesPostgres.updatedAt,
            input.updatedBefore,
          ),
        ),
      )
      .orderBy(asc(pgSchema.runtimeDependenciesPostgres.updatedAt));
    return rows.map(toRuntimeDependency);
  }

  async updateRuntimeDependencyStatus(
    input: UpdateRuntimeDependencyStatusInput,
  ): Promise<boolean> {
    const now = input.now ?? nowIso();
    const set: Partial<
      typeof pgSchema.runtimeDependenciesPostgres.$inferInsert
    > = {
      status: input.status,
      updatedAt: now,
    };
    if (input.artifact !== undefined) {
      set.storageType = input.artifact?.storageType ?? null;
      set.storageRef = input.artifact?.storageRef ?? null;
      set.contentHash = input.artifact?.contentHash ?? null;
      set.sizeBytes = input.artifact?.sizeBytes ?? null;
    }
    if (input.failureReason !== undefined) {
      set.failureReason = input.failureReason;
    }
    const filters: SQL[] = [
      eq(pgSchema.runtimeDependenciesPostgres.id, input.id),
    ];
    if (input.fromStatus !== undefined) {
      const fromStatuses = Array.isArray(input.fromStatus)
        ? input.fromStatus
        : [input.fromStatus];
      filters.push(
        inArray(pgSchema.runtimeDependenciesPostgres.status, fromStatuses),
      );
    }
    const rows = await this.db
      .update(pgSchema.runtimeDependenciesPostgres)
      .set(set)
      .where(and(...filters))
      .returning({ id: pgSchema.runtimeDependenciesPostgres.id });
    return rows.length > 0;
  }
}
