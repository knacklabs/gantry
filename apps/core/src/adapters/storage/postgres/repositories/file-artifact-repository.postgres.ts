import { randomUUID } from 'node:crypto';

import { and, desc, eq, isNull, max, sql, type SQL } from 'drizzle-orm';

import type {
  FileArtifact,
  FileArtifactId,
} from '../../../../domain/file-artifacts/file-artifact.js';
import {
  describeFileArtifact,
  FileArtifactNotFoundError,
  FileArtifactVersionConflictError,
} from '../../../../domain/file-artifacts/file-artifact.js';
import {
  normalizeFileArtifactPath,
  normalizeFileArtifactScope,
} from '../../../../domain/file-artifacts/virtual-path.js';
import type {
  FileArtifactListInput,
  FileArtifactStore,
  FileArtifactWriteInput,
} from '../../../../domain/ports/file-artifact-store.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import { LocalFileArtifactBytes } from '../../../artifacts/files/local-file-artifact-bytes.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';

type FileArtifactRow = typeof pgSchema.fileArtifactsPostgres.$inferSelect;
const MAX_VERSION_WRITE_ATTEMPTS = 3;

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return fallback;
  }
}

function shouldReturnString(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('markdown')
  );
}

export class PostgresFileArtifactStore implements FileArtifactStore {
  constructor(
    private readonly db: CanonicalDb,
    private readonly bytes: LocalFileArtifactBytes,
  ) {}

  async writeFileArtifact(input: FileArtifactWriteInput) {
    const virtualScope = normalizeFileArtifactScope(input.virtualScope);
    const virtualPath = normalizeFileArtifactPath(input.virtualPath);
    const contentType = input.contentType ?? 'application/octet-stream';
    let lastUniqueViolation: unknown;
    for (let attempt = 0; attempt < MAX_VERSION_WRITE_ATTEMPTS; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          await lockFileArtifactVersionPath(tx, {
            appId: input.appId,
            agentId: input.agentId,
            virtualScope,
            virtualPath,
          });
          const id = `file-artifact:${randomUUID()}` as FileArtifactId;
          const version = await this.nextVersion(
            {
              appId: input.appId,
              agentId: input.agentId,
              virtualScope,
              virtualPath,
            },
            tx,
          );
          // Optimistic concurrency, enforced under the version-path lock so it
          // is atomic with the write: the current latest version is one below
          // the version we are about to allocate.
          if (
            input.expectedVersion !== undefined &&
            version - 1 !== input.expectedVersion
          ) {
            throw new FileArtifactVersionConflictError(version - 1);
          }
          const stored = await this.bytes.putBytes({
            id,
            appId: input.appId,
            agentId: input.agentId,
            virtualScope,
            virtualPath,
            version,
            content: input.content,
          });
          const createdAt = nowIso();
          try {
            await tx.insert(pgSchema.fileArtifactsPostgres).values({
              id,
              appId: input.appId,
              agentId: input.agentId,
              virtualScope,
              virtualPath,
              version,
              storageType: 'local-filesystem',
              storageRef: stored.storageRef,
              contentHash: stored.contentHash,
              sizeBytes: stored.sizeBytes,
              contentType,
              metadataJson: encodeJson(input.metadata ?? {}),
              createdBy: input.createdBy,
              promotedFromArtifactId: input.promotedFromArtifactId,
              createdAt,
            });
          } catch (err) {
            if (isKnownRejectedInsert(err)) {
              await this.bytes.removeBytes(stored.storageRef);
            }
            throw err;
          }
          return {
            id,
            appId: input.appId,
            agentId: input.agentId,
            virtualScope,
            virtualPath,
            version,
            storageType: 'local-filesystem',
            storageRef: stored.storageRef,
            contentHash: stored.contentHash,
            sizeBytes: stored.sizeBytes,
            contentType,
            metadata: input.metadata ?? {},
            createdAt,
            ...(input.createdBy ? { createdBy: input.createdBy } : {}),
            ...(input.promotedFromArtifactId
              ? { promotedFromArtifactId: input.promotedFromArtifactId }
              : {}),
          } satisfies FileArtifact;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          lastUniqueViolation = err;
          continue;
        }
        throw err;
      }
    }
    throw lastUniqueViolation instanceof Error
      ? lastUniqueViolation
      : new Error('FileArtifact version allocation failed after retries.');
  }

  async readFileArtifact(input: {
    id?: FileArtifactId;
    appId: string;
    agentId: string;
    virtualScope?: string;
    virtualPath?: string;
    version?: number;
  }) {
    const artifact = await this.findArtifact(input);
    if (!artifact) throw new FileArtifactNotFoundError();
    const bytes = await this.bytes.getBytes(artifact.storageRef, {
      hash: artifact.contentHash,
      sizeBytes: artifact.sizeBytes,
    });
    return {
      artifact,
      content: shouldReturnString(artifact.contentType)
        ? bytes.toString('utf-8')
        : bytes,
    };
  }

  async listFileArtifacts(input: FileArtifactListInput) {
    const rows = await this.queryRows(
      input,
      input.limit ?? 50,
      undefined,
      input.version,
    );
    return rows.map((row) => describeFileArtifact(this.fromRow(row)));
  }

  async promoteScratch(input: {
    appId: string;
    agentId: string;
    scratchPath: string;
    targetScope: string;
    targetPath: string;
    createdBy?: string;
    metadata?: Record<string, unknown>;
  }) {
    const source = await this.readFileArtifact({
      appId: input.appId,
      agentId: input.agentId,
      virtualScope: 'scratch',
      virtualPath: input.scratchPath,
    });
    return this.writeFileArtifact({
      appId: input.appId,
      agentId: input.agentId,
      virtualScope: input.targetScope,
      virtualPath: input.targetPath,
      content: source.content,
      contentType: source.artifact.contentType,
      createdBy: input.createdBy,
      metadata: {
        ...(input.metadata ?? {}),
        promotedFromScope: source.artifact.virtualScope,
        promotedFromPath: source.artifact.virtualPath,
        promotedFromVersion: source.artifact.version,
      },
      promotedFromArtifactId: source.artifact.id,
    });
  }

  private async nextVersion(
    input: {
      appId: string;
      agentId: string;
      virtualScope: string;
      virtualPath: string;
    },
    executor: CanonicalExecutor = this.db,
  ): Promise<number> {
    const rows = await executor
      .select({ version: max(pgSchema.fileArtifactsPostgres.version) })
      .from(pgSchema.fileArtifactsPostgres)
      .where(
        and(
          eq(pgSchema.fileArtifactsPostgres.appId, input.appId),
          eq(pgSchema.fileArtifactsPostgres.agentId, input.agentId),
          eq(pgSchema.fileArtifactsPostgres.virtualScope, input.virtualScope),
          eq(pgSchema.fileArtifactsPostgres.virtualPath, input.virtualPath),
        ),
      );
    return Number(rows[0]?.version ?? 0) + 1;
  }

  private async findArtifact(input: {
    id?: FileArtifactId;
    appId: string;
    agentId: string;
    virtualScope?: string;
    virtualPath?: string;
    version?: number;
  }): Promise<FileArtifact | undefined> {
    const rows = await this.queryRows(
      {
        appId: input.appId,
        agentId: input.agentId,
        virtualScope: input.virtualScope,
        virtualPath: input.virtualPath,
      },
      1,
      input.id,
      input.version,
    );
    return rows[0] ? this.fromRow(rows[0]) : undefined;
  }

  private async queryRows(
    input: FileArtifactListInput,
    limit: number,
    id?: FileArtifactId,
    version?: number,
  ): Promise<FileArtifactRow[]> {
    const table = pgSchema.fileArtifactsPostgres;
    const predicates: SQL[] = [
      eq(table.appId, input.appId),
      eq(table.agentId, input.agentId),
    ];
    if (id) predicates.push(eq(table.id, id));
    if (input.virtualScope) {
      predicates.push(
        eq(table.virtualScope, normalizeFileArtifactScope(input.virtualScope)),
      );
    }
    if (input.virtualPath) {
      predicates.push(
        eq(table.virtualPath, normalizeFileArtifactPath(input.virtualPath)),
      );
    }
    if (version !== undefined) predicates.push(eq(table.version, version));
    if (!input.includeDeleted) predicates.push(isNull(table.deletedAt));

    return this.db
      .select()
      .from(table)
      .where(and(...predicates))
      .orderBy(desc(table.version), desc(table.createdAt), desc(table.id))
      .limit(limit);
  }

  private fromRow(row: FileArtifactRow): FileArtifact {
    return {
      id: row.id as FileArtifactId,
      appId: row.appId,
      agentId: row.agentId,
      virtualScope: row.virtualScope,
      virtualPath: row.virtualPath,
      version: row.version,
      storageType: 'local-filesystem',
      storageRef: row.storageRef,
      contentHash: row.contentHash,
      sizeBytes: row.sizeBytes,
      contentType: row.contentType,
      metadata: parseJson(row.metadataJson, {}),
      createdAt: row.createdAt,
      ...(row.createdBy ? { createdBy: row.createdBy } : {}),
      ...(row.promotedFromArtifactId
        ? {
            promotedFromArtifactId:
              row.promotedFromArtifactId as FileArtifactId,
          }
        : {}),
      ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
    };
  }
}

async function lockFileArtifactVersionPath(
  executor: CanonicalExecutor,
  input: {
    appId: string;
    agentId: string;
    virtualScope: string;
    virtualPath: string;
  },
): Promise<void> {
  const lockKey = [
    'file_artifacts',
    input.appId,
    input.agentId,
    input.virtualScope,
    input.virtualPath,
  ].join(':');
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
}

function isUniqueViolation(err: unknown): boolean {
  return sqlStateCode(err) === '23505';
}

function isKnownRejectedInsert(err: unknown): boolean {
  return sqlStateCode(err)?.startsWith('23') === true;
}

function sqlStateCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
