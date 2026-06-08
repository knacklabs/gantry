import { and, desc, eq } from 'drizzle-orm';

import { EnvRuntimeSecretProvider } from '../../../credentials/env-runtime-secret-provider.js';
import type { RuntimeSecretProvider } from '../../../../domain/ports/runtime-secret-provider.js';
import type { CapabilitySecretRepository } from '../../../../domain/ports/repositories.js';
import type {
  CapabilitySecret,
  CapabilitySecretId,
  CapabilitySecretMetadata,
} from '../../../../domain/capability-secrets/capability-secrets.js';
import {
  assertValidCapabilitySecretName,
  normalizeCapabilitySecretName,
} from '../../../../domain/capability-secrets/capability-secrets.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import { logger } from '../../../../infrastructure/logging/logger.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import {
  CredentialSecretCryptoIntegrityError,
  decryptCredentialSecretValue,
  encryptCredentialSecretValue,
} from './credential-secret-crypto.js';

export class PostgresCapabilitySecretRepository implements CapabilitySecretRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly runtimeSecrets: RuntimeSecretProvider = new EnvRuntimeSecretProvider(),
  ) {}

  async getSecret(input: {
    appId: CapabilitySecret['appId'];
    name: string;
  }): Promise<CapabilitySecret | null> {
    const name = normalizeCapabilitySecretName(input.name);
    assertValidCapabilitySecretName(name);
    const rows = await this.db
      .select()
      .from(pgSchema.capabilitySecretsPostgres)
      .where(
        and(
          eq(pgSchema.capabilitySecretsPostgres.appId, input.appId),
          eq(pgSchema.capabilitySecretsPostgres.name, name),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    try {
      return {
        ...mapMetadata(row),
        value: decryptCapabilitySecretValue(
          row.valueEncrypted,
          {
            appId: row.appId,
            name: row.name,
          },
          this.runtimeSecrets,
        ),
      };
    } catch (error) {
      if (error instanceof CredentialSecretCryptoIntegrityError) {
        // Wrong encryption key or tampered ciphertext — not the same as an
        // absent secret. Surface it so a botched key rotation is debuggable
        // instead of looking like "needs setup", but still degrade gracefully.
        logger.error(
          { err: error, appId: input.appId, name },
          'Capability secret failed integrity check; treating as unavailable',
        );
        return null;
      }
      throw error;
    }
  }

  async listSecrets(input: {
    appId: CapabilitySecretMetadata['appId'];
  }): Promise<CapabilitySecretMetadata[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.capabilitySecretsPostgres)
      .where(eq(pgSchema.capabilitySecretsPostgres.appId, input.appId))
      .orderBy(desc(pgSchema.capabilitySecretsPostgres.updatedAt));
    return rows.map(mapMetadata);
  }

  async upsertSecret(input: {
    appId: CapabilitySecretMetadata['appId'];
    name: string;
    value: string;
    allowedCapabilityIds?: string[];
    actor?: string;
    now?: string;
  }): Promise<CapabilitySecretMetadata> {
    const name = normalizeCapabilitySecretName(input.name);
    assertValidCapabilitySecretName(name);
    if (!input.value) {
      throw new Error(`Secret value is required for ${name}.`);
    }
    const now = input.now ?? nowIso();
    const id = `capability-secret:${input.appId}:${name}` as CapabilitySecretId;
    const allowedCapabilityIds = normalizeAllowedCapabilityIds(
      input.allowedCapabilityIds ?? [],
    );
    const rows = await this.db
      .insert(pgSchema.capabilitySecretsPostgres)
      .values({
        id,
        appId: input.appId,
        name,
        valueEncrypted: encryptCapabilitySecretValue(
          input.value,
          {
            appId: input.appId,
            name,
          },
          this.runtimeSecrets,
        ),
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
          valueEncrypted: encryptCapabilitySecretValue(
            input.value,
            {
              appId: input.appId,
              name,
            },
            this.runtimeSecrets,
          ),
          allowedCapabilityIdsJson: encodeJson(allowedCapabilityIds),
          updatedBy: input.actor ?? null,
          updatedAt: now,
        },
      })
      .returning();
    return mapMetadata(rows[0]!);
  }

  async deleteSecret(input: {
    appId: CapabilitySecretMetadata['appId'];
    name: string;
  }): Promise<boolean> {
    const name = normalizeCapabilitySecretName(input.name);
    assertValidCapabilitySecretName(name);
    const rows = await this.db
      .delete(pgSchema.capabilitySecretsPostgres)
      .where(
        and(
          eq(pgSchema.capabilitySecretsPostgres.appId, input.appId),
          eq(pgSchema.capabilitySecretsPostgres.name, name),
        ),
      )
      .returning({ id: pgSchema.capabilitySecretsPostgres.id });
    return rows.length > 0;
  }
}

function mapMetadata(row: {
  id: string;
  appId: string;
  name: string;
  allowedCapabilityIdsJson: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}): CapabilitySecretMetadata {
  return {
    id: row.id as CapabilitySecretId,
    appId: row.appId as CapabilitySecretMetadata['appId'],
    name: row.name,
    allowedCapabilityIds: parseJsonArray(row.allowedCapabilityIdsJson),
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

function normalizeAllowedCapabilityIds(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  ];
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function toIsoTimestamp(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

export function encryptCapabilitySecretValue(
  value: string,
  context: { appId: string; name: string },
  runtimeSecrets: RuntimeSecretProvider,
): string {
  return encryptCredentialSecretValue(
    value,
    capabilitySecretAadContext(context),
    runtimeSecrets,
  );
}

export function decryptCapabilitySecretValue(
  stored: string,
  context: { appId: string; name: string },
  runtimeSecrets: RuntimeSecretProvider,
): string {
  return decryptCredentialSecretValue(
    stored,
    capabilitySecretAadContext(context),
    runtimeSecrets,
  );
}

function capabilitySecretAadContext(context: { appId: string; name: string }) {
  return {
    appId: context.appId,
    subjectKind: 'capability_secret' as const,
    subjectId: normalizeCapabilitySecretName(context.name),
    schemaVersion: 1,
  };
}
