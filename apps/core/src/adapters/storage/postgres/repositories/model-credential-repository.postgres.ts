import { and, desc, eq } from 'drizzle-orm';

import { EnvRuntimeSecretProvider } from '../../../credentials/env-runtime-secret-provider.js';
import type { RuntimeSecretProvider } from '../../../../domain/ports/runtime-secret-provider.js';
import type { ModelCredentialRepository } from '../../../../domain/ports/repositories.js';
import type {
  ModelCredential,
  ModelCredentialFieldFingerprint,
  ModelCredentialId,
  ModelCredentialMetadata,
  ModelCredentialProvider,
  ModelCredentialStatus,
} from '../../../../domain/model-credentials/model-credentials.js';
import type { ModelCredentialPayload } from '../../../../shared/model-provider-registry.js';
import { normalizeModelCredentialProvider } from '../../../../domain/model-credentials/model-credentials.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import {
  decryptCredentialSecretValue,
  encryptCredentialSecretValue,
} from './credential-secret-crypto.js';

export class PostgresModelCredentialRepository implements ModelCredentialRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly runtimeSecrets: RuntimeSecretProvider = new EnvRuntimeSecretProvider(),
  ) {}

  async getModelCredential(input: {
    appId: ModelCredential['appId'];
    providerId: ModelCredentialProvider;
  }): Promise<ModelCredential | null> {
    const providerId = normalizeModelCredentialProvider(input.providerId);
    const rows = await this.db
      .select()
      .from(pgSchema.modelCredentialsPostgres)
      .where(
        and(
          eq(pgSchema.modelCredentialsPostgres.appId, input.appId),
          eq(pgSchema.modelCredentialsPostgres.providerId, providerId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row
      ? {
          ...mapMetadata(row),
          payload: parseCredentialPayload(
            decryptCredentialSecretValue(
              row.payloadEncrypted,
              modelCredentialAadContext({
                appId: row.appId,
                providerId: row.providerId,
                authMode: row.authMode,
                schemaVersion: row.schemaVersion,
              }),
              this.runtimeSecrets,
            ),
          ),
        }
      : null;
  }

  async listModelCredentials(input: {
    appId: ModelCredentialMetadata['appId'];
  }): Promise<ModelCredentialMetadata[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.modelCredentialsPostgres)
      .where(eq(pgSchema.modelCredentialsPostgres.appId, input.appId))
      .orderBy(desc(pgSchema.modelCredentialsPostgres.updatedAt));
    return rows.map(mapMetadata);
  }

  async upsertModelCredential(input: {
    appId: ModelCredentialMetadata['appId'];
    providerId: ModelCredentialProvider;
    authMode: string;
    schemaVersion: number;
    payload: ModelCredentialPayload;
    fingerprint: string;
    fieldFingerprints: ModelCredentialFieldFingerprint[];
    actor?: string;
    now?: string;
  }): Promise<ModelCredentialMetadata> {
    const providerId = normalizeModelCredentialProvider(input.providerId);
    const now = input.now ?? nowIso();
    const id =
      `model-credential:${input.appId}:${providerId}` as ModelCredentialId;
    const encrypted = encryptCredentialSecretValue(
      JSON.stringify(input.payload),
      modelCredentialAadContext({
        appId: input.appId,
        providerId,
        authMode: input.authMode,
        schemaVersion: input.schemaVersion,
      }),
      this.runtimeSecrets,
    );
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
    return mapMetadata(rows[0]!);
  }

  async disableModelCredential(input: {
    appId: ModelCredentialMetadata['appId'];
    providerId: ModelCredentialProvider;
    actor?: string;
    now?: string;
  }): Promise<ModelCredentialMetadata | null> {
    const providerId = normalizeModelCredentialProvider(input.providerId);
    const rows = await this.db
      .update(pgSchema.modelCredentialsPostgres)
      .set({
        status: 'disabled',
        updatedBy: input.actor ?? null,
        updatedAt: input.now ?? nowIso(),
      })
      .where(
        and(
          eq(pgSchema.modelCredentialsPostgres.appId, input.appId),
          eq(pgSchema.modelCredentialsPostgres.providerId, providerId),
        ),
      )
      .returning();
    return rows[0] ? mapMetadata(rows[0]) : null;
  }
}

function mapMetadata(row: {
  id: string;
  appId: string;
  providerId: string;
  authMode: string;
  status: string;
  schemaVersion: number;
  fingerprint: string;
  fieldFingerprintsJson: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}): ModelCredentialMetadata {
  return {
    id: row.id as ModelCredentialId,
    appId: row.appId as ModelCredentialMetadata['appId'],
    providerId: normalizeModelCredentialProvider(row.providerId),
    authMode: row.authMode,
    status:
      row.status === 'active'
        ? 'active'
        : ('disabled' as ModelCredentialStatus),
    fingerprint: row.fingerprint,
    schemaVersion: row.schemaVersion,
    fieldFingerprints: parseFieldFingerprints(row.fieldFingerprintsJson),
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

function parseCredentialPayload(raw: string): ModelCredentialPayload {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Model credential payload is malformed.');
  }
  return parsed as ModelCredentialPayload;
}

function parseFieldFingerprints(
  raw: string,
): ModelCredentialFieldFingerprint[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (item): item is ModelCredentialFieldFingerprint =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as { field?: unknown }).field === 'string' &&
        typeof (item as { fingerprint?: unknown }).fingerprint === 'string',
    )
    .map((item) => ({ field: item.field, fingerprint: item.fingerprint }));
}

function toIsoTimestamp(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

function modelCredentialAadContext(input: {
  appId: string;
  providerId: string;
  authMode: string;
  schemaVersion: number;
}) {
  return {
    appId: input.appId,
    subjectKind: 'model_credential' as const,
    subjectId: normalizeModelCredentialProvider(input.providerId),
    authMode: input.authMode,
    schemaVersion: input.schemaVersion,
  };
}
