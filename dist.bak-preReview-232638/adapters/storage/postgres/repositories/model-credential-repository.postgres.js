import { and, desc, eq } from 'drizzle-orm';
import { EnvRuntimeSecretProvider } from '../../../credentials/env-runtime-secret-provider.js';
import { normalizeModelCredentialProvider } from '../../../../domain/model-credentials/model-credentials.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import { decryptCredentialSecretValue, encryptCredentialSecretValue, } from './credential-secret-crypto.js';
export class PostgresModelCredentialRepository {
    db;
    runtimeSecrets;
    constructor(db, runtimeSecrets = new EnvRuntimeSecretProvider()) {
        this.db = db;
        this.runtimeSecrets = runtimeSecrets;
    }
    async getModelCredential(input) {
        const providerId = normalizeModelCredentialProvider(input.providerId);
        const rows = await this.db
            .select()
            .from(pgSchema.modelCredentialsPostgres)
            .where(and(eq(pgSchema.modelCredentialsPostgres.appId, input.appId), eq(pgSchema.modelCredentialsPostgres.providerId, providerId)))
            .limit(1);
        const row = rows[0];
        return row
            ? {
                ...mapMetadata(row),
                payload: parseCredentialPayload(decryptCredentialSecretValue(row.payloadEncrypted, modelCredentialAadContext({
                    appId: row.appId,
                    providerId: row.providerId,
                    authMode: row.authMode,
                    schemaVersion: row.schemaVersion,
                }), this.runtimeSecrets)),
            }
            : null;
    }
    async listModelCredentials(input) {
        const rows = await this.db
            .select()
            .from(pgSchema.modelCredentialsPostgres)
            .where(eq(pgSchema.modelCredentialsPostgres.appId, input.appId))
            .orderBy(desc(pgSchema.modelCredentialsPostgres.updatedAt));
        return rows.map(mapMetadata);
    }
    async upsertModelCredential(input) {
        const providerId = normalizeModelCredentialProvider(input.providerId);
        const now = input.now ?? nowIso();
        const id = `model-credential:${input.appId}:${providerId}`;
        const encrypted = encryptCredentialSecretValue(JSON.stringify(input.payload), modelCredentialAadContext({
            appId: input.appId,
            providerId,
            authMode: input.authMode,
            schemaVersion: input.schemaVersion,
        }), this.runtimeSecrets);
        const rows = await this.db
            .insert(pgSchema.modelCredentialsPostgres)
            .values({
            id,
            appId: input.appId,
            providerId,
            authMode: input.authMode,
            schemaVersion: input.schemaVersion,
            payloadEncrypted: encrypted,
            fingerprint: input.fingerprint,
            fieldFingerprintsJson: JSON.stringify(input.fieldFingerprints),
            status: 'active',
            createdBy: input.actor ?? null,
            updatedBy: input.actor ?? null,
            createdAt: now,
            updatedAt: now,
        })
            .onConflictDoUpdate({
            target: [
                pgSchema.modelCredentialsPostgres.appId,
                pgSchema.modelCredentialsPostgres.providerId,
            ],
            set: {
                authMode: input.authMode,
                schemaVersion: input.schemaVersion,
                payloadEncrypted: encrypted,
                fingerprint: input.fingerprint,
                fieldFingerprintsJson: JSON.stringify(input.fieldFingerprints),
                status: 'active',
                updatedBy: input.actor ?? null,
                updatedAt: now,
            },
        })
            .returning();
        return mapMetadata(rows[0]);
    }
    async disableModelCredential(input) {
        const providerId = normalizeModelCredentialProvider(input.providerId);
        const rows = await this.db
            .update(pgSchema.modelCredentialsPostgres)
            .set({
            status: 'disabled',
            updatedBy: input.actor ?? null,
            updatedAt: input.now ?? nowIso(),
        })
            .where(and(eq(pgSchema.modelCredentialsPostgres.appId, input.appId), eq(pgSchema.modelCredentialsPostgres.providerId, providerId)))
            .returning();
        return rows[0] ? mapMetadata(rows[0]) : null;
    }
}
function mapMetadata(row) {
    return {
        id: row.id,
        appId: row.appId,
        providerId: normalizeModelCredentialProvider(row.providerId),
        authMode: row.authMode,
        status: row.status === 'active'
            ? 'active'
            : 'disabled',
        fingerprint: row.fingerprint,
        schemaVersion: row.schemaVersion,
        fieldFingerprints: parseFieldFingerprints(row.fieldFingerprintsJson),
        ...(row.createdBy ? { createdBy: row.createdBy } : {}),
        ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
        createdAt: toIsoTimestamp(row.createdAt),
        updatedAt: toIsoTimestamp(row.updatedAt),
    };
}
function parseCredentialPayload(raw) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Model credential payload is malformed.');
    }
    return parsed;
}
function parseFieldFingerprints(raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed))
        return [];
    return parsed
        .filter((item) => Boolean(item) &&
        typeof item === 'object' &&
        typeof item.field === 'string' &&
        typeof item.fingerprint === 'string')
        .map((item) => ({ field: item.field, fingerprint: item.fingerprint }));
}
function toIsoTimestamp(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
function modelCredentialAadContext(input) {
    return {
        appId: input.appId,
        subjectKind: 'model_credential',
        subjectId: normalizeModelCredentialProvider(input.providerId),
        authMode: input.authMode,
        schemaVersion: input.schemaVersion,
    };
}
