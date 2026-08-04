import { and, desc, eq } from 'drizzle-orm';
import { EnvRuntimeSecretProvider } from '../../../credentials/env-runtime-secret-provider.js';
import { assertValidCapabilitySecretName, normalizeCapabilitySecretName, } from '../../../../domain/capability-secrets/capability-secrets.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import { logger } from '../../../../infrastructure/logging/logger.js';
import * as pgSchema from '../schema/schema.js';
import { CredentialSecretCryptoIntegrityError, decryptCredentialSecretValue, encryptCredentialSecretValue, } from './credential-secret-crypto.js';
export class PostgresCapabilitySecretRepository {
    db;
    runtimeSecrets;
    constructor(db, runtimeSecrets = new EnvRuntimeSecretProvider()) {
        this.db = db;
        this.runtimeSecrets = runtimeSecrets;
    }
    async getSecret(input) {
        const name = normalizeCapabilitySecretName(input.name);
        assertValidCapabilitySecretName(name);
        const rows = await this.db
            .select()
            .from(pgSchema.capabilitySecretsPostgres)
            .where(and(eq(pgSchema.capabilitySecretsPostgres.appId, input.appId), eq(pgSchema.capabilitySecretsPostgres.name, name)))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        try {
            return {
                ...mapMetadata(row),
                value: decryptCapabilitySecretValue(row.valueEncrypted, {
                    appId: row.appId,
                    name: row.name,
                }, this.runtimeSecrets),
            };
        }
        catch (error) {
            if (error instanceof CredentialSecretCryptoIntegrityError) {
                // Wrong encryption key or tampered ciphertext — not the same as an
                // absent secret. Surface it so a botched key rotation is debuggable
                // instead of looking like "needs setup", but still degrade gracefully.
                logger.error({ err: error, appId: input.appId, name }, 'Capability secret failed integrity check; treating as unavailable');
                return null;
            }
            throw error;
        }
    }
    async listSecrets(input) {
        const rows = await this.db
            .select()
            .from(pgSchema.capabilitySecretsPostgres)
            .where(eq(pgSchema.capabilitySecretsPostgres.appId, input.appId))
            .orderBy(desc(pgSchema.capabilitySecretsPostgres.updatedAt));
        return rows.map(mapMetadata);
    }
    async upsertSecret(input) {
        const name = normalizeCapabilitySecretName(input.name);
        assertValidCapabilitySecretName(name);
        if (!input.value) {
            throw new Error(`Secret value is required for ${name}.`);
        }
        const now = input.now ?? nowIso();
        const id = `capability-secret:${input.appId}:${name}`;
        const allowedCapabilityIds = normalizeAllowedCapabilityIds(input.allowedCapabilityIds ?? []);
        const rows = await this.db
            .insert(pgSchema.capabilitySecretsPostgres)
            .values({
            id,
            appId: input.appId,
            name,
            valueEncrypted: encryptCapabilitySecretValue(input.value, {
                appId: input.appId,
                name,
            }, this.runtimeSecrets),
            allowedCapabilityIdsJson: encodeJson(allowedCapabilityIds),
            createdBy: input.actor ?? null,
            updatedBy: input.actor ?? null,
            createdAt: now,
            updatedAt: now,
        })
            .onConflictDoUpdate({
            target: [
                pgSchema.capabilitySecretsPostgres.appId,
                pgSchema.capabilitySecretsPostgres.name,
            ],
            set: {
                valueEncrypted: encryptCapabilitySecretValue(input.value, {
                    appId: input.appId,
                    name,
                }, this.runtimeSecrets),
                allowedCapabilityIdsJson: encodeJson(allowedCapabilityIds),
                updatedBy: input.actor ?? null,
                updatedAt: now,
            },
        })
            .returning();
        return mapMetadata(rows[0]);
    }
    async deleteSecret(input) {
        const name = normalizeCapabilitySecretName(input.name);
        assertValidCapabilitySecretName(name);
        const rows = await this.db
            .delete(pgSchema.capabilitySecretsPostgres)
            .where(and(eq(pgSchema.capabilitySecretsPostgres.appId, input.appId), eq(pgSchema.capabilitySecretsPostgres.name, name)))
            .returning({ id: pgSchema.capabilitySecretsPostgres.id });
        return rows.length > 0;
    }
}
function mapMetadata(row) {
    return {
        id: row.id,
        appId: row.appId,
        name: row.name,
        allowedCapabilityIds: parseJsonArray(row.allowedCapabilityIdsJson),
        ...(row.createdBy ? { createdBy: row.createdBy } : {}),
        ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
        createdAt: toIsoTimestamp(row.createdAt),
        updatedAt: toIsoTimestamp(row.updatedAt),
    };
}
function normalizeAllowedCapabilityIds(values) {
    return [
        ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
    ];
}
function encodeJson(value) {
    return JSON.stringify(value ?? null);
}
function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((item) => typeof item === 'string')
            : [];
    }
    catch {
        return [];
    }
}
function toIsoTimestamp(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
export function encryptCapabilitySecretValue(value, context, runtimeSecrets) {
    return encryptCredentialSecretValue(value, capabilitySecretAadContext(context), runtimeSecrets);
}
export function decryptCapabilitySecretValue(stored, context, runtimeSecrets) {
    return decryptCredentialSecretValue(stored, capabilitySecretAadContext(context), runtimeSecrets);
}
function capabilitySecretAadContext(context) {
    return {
        appId: context.appId,
        subjectKind: 'capability_secret',
        subjectId: normalizeCapabilitySecretName(context.name),
        schemaVersion: 1,
    };
}
