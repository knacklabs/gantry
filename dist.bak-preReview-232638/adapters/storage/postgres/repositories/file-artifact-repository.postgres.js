import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, max, sql } from 'drizzle-orm';
import { describeFileArtifact, FileArtifactNotFoundError, FileArtifactVersionConflictError, } from '../../../../domain/file-artifacts/file-artifact.js';
import { normalizeFileArtifactPath, normalizeFileArtifactScope, } from '../../../../domain/file-artifacts/virtual-path.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
const MAX_VERSION_WRITE_ATTEMPTS = 3;
function encodeJson(value) {
    return JSON.stringify(value ?? {});
}
function parseJson(value, fallback) {
    if (typeof value !== 'string' || value.length === 0)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch (err) {
        if (!(err instanceof SyntaxError))
            throw err;
        return fallback;
    }
}
function shouldReturnString(contentType) {
    return (contentType.startsWith('text/') ||
        contentType.includes('json') ||
        contentType.includes('markdown'));
}
export class PostgresFileArtifactStore {
    db;
    bytes;
    constructor(db, bytes) {
        this.db = db;
        this.bytes = bytes;
    }
    async writeFileArtifact(input) {
        const virtualScope = normalizeFileArtifactScope(input.virtualScope);
        const virtualPath = normalizeFileArtifactPath(input.virtualPath);
        const contentType = input.contentType ?? 'application/octet-stream';
        let lastUniqueViolation;
        for (let attempt = 0; attempt < MAX_VERSION_WRITE_ATTEMPTS; attempt += 1) {
            try {
                return await this.db.transaction(async (tx) => {
                    await lockFileArtifactVersionPath(tx, {
                        appId: input.appId,
                        agentId: input.agentId,
                        virtualScope,
                        virtualPath,
                    });
                    const id = `file-artifact:${randomUUID()}`;
                    const version = await this.nextVersion({
                        appId: input.appId,
                        agentId: input.agentId,
                        virtualScope,
                        virtualPath,
                    }, tx);
                    // Optimistic concurrency, enforced under the version-path lock so it
                    // is atomic with the write: the current latest version is one below
                    // the version we are about to allocate.
                    if (input.expectedVersion !== undefined &&
                        version - 1 !== input.expectedVersion) {
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
                    }
                    catch (err) {
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
                    };
                });
            }
            catch (err) {
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
    async readFileArtifact(input) {
        const artifact = await this.findArtifact(input);
        if (!artifact)
            throw new FileArtifactNotFoundError();
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
    async listFileArtifacts(input) {
        const rows = await this.queryRows(input, input.limit ?? 50, undefined, input.version);
        return rows.map((row) => describeFileArtifact(this.fromRow(row)));
    }
    async promoteScratch(input) {
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
    async nextVersion(input, executor = this.db) {
        const rows = await executor
            .select({ version: max(pgSchema.fileArtifactsPostgres.version) })
            .from(pgSchema.fileArtifactsPostgres)
            .where(and(eq(pgSchema.fileArtifactsPostgres.appId, input.appId), eq(pgSchema.fileArtifactsPostgres.agentId, input.agentId), eq(pgSchema.fileArtifactsPostgres.virtualScope, input.virtualScope), eq(pgSchema.fileArtifactsPostgres.virtualPath, input.virtualPath)));
        return Number(rows[0]?.version ?? 0) + 1;
    }
    async findArtifact(input) {
        const rows = await this.queryRows({
            appId: input.appId,
            agentId: input.agentId,
            virtualScope: input.virtualScope,
            virtualPath: input.virtualPath,
        }, 1, input.id, input.version);
        return rows[0] ? this.fromRow(rows[0]) : undefined;
    }
    async queryRows(input, limit, id, version) {
        const table = pgSchema.fileArtifactsPostgres;
        const predicates = [
            eq(table.appId, input.appId),
            eq(table.agentId, input.agentId),
        ];
        if (id)
            predicates.push(eq(table.id, id));
        if (input.virtualScope) {
            predicates.push(eq(table.virtualScope, normalizeFileArtifactScope(input.virtualScope)));
        }
        if (input.virtualPath) {
            predicates.push(eq(table.virtualPath, normalizeFileArtifactPath(input.virtualPath)));
        }
        if (version !== undefined)
            predicates.push(eq(table.version, version));
        if (!input.includeDeleted)
            predicates.push(isNull(table.deletedAt));
        return this.db
            .select()
            .from(table)
            .where(and(...predicates))
            .orderBy(desc(table.version), desc(table.createdAt), desc(table.id))
            .limit(limit);
    }
    fromRow(row) {
        return {
            id: row.id,
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
                    promotedFromArtifactId: row.promotedFromArtifactId,
                }
                : {}),
            ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
        };
    }
}
async function lockFileArtifactVersionPath(executor, input) {
    const lockKey = [
        'file_artifacts',
        input.appId,
        input.agentId,
        input.virtualScope,
        input.virtualPath,
    ].join(':');
    await executor.execute(sql `SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}
function isUniqueViolation(err) {
    return sqlStateCode(err) === '23505';
}
function isKnownRejectedInsert(err) {
    return sqlStateCode(err)?.startsWith('23') === true;
}
function sqlStateCode(err) {
    let current = err;
    for (let depth = 0; depth < 5; depth += 1) {
        if (!current || typeof current !== 'object')
            return undefined;
        const code = current.code;
        if (typeof code === 'string')
            return code;
        current = current.cause;
    }
    return undefined;
}
