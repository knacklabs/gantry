import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const SECRET_ENCRYPTION_KEY_ENV = 'SECRET_ENCRYPTION_KEY';
const CAPABILITY_SECRET_PREFIX = 'enc:v1:';

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
    return row
      ? {
          ...mapMetadata(row),
          value: decryptCapabilitySecretValue(
            row.valueEncrypted,
            this.runtimeSecrets,
          ),
        }
      : null;
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

function resolveCapabilitySecretKey(
  runtimeSecrets: RuntimeSecretProvider,
): Buffer {
  const raw = runtimeSecrets
    .getOptionalSecret({ env: SECRET_ENCRYPTION_KEY_ENV })
    ?.trim();
  if (!raw) {
    throw new Error(
      `${SECRET_ENCRYPTION_KEY_ENV} is required for Gantry Secrets encryption.`,
    );
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;
  throw new Error(
    `${SECRET_ENCRYPTION_KEY_ENV} must be a base64-encoded 32-byte secret for Gantry Secrets encryption.`,
  );
}

export function encryptCapabilitySecretValue(
  value: string,
  runtimeSecrets: RuntimeSecretProvider,
): string {
  if (value.startsWith(CAPABILITY_SECRET_PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    resolveCapabilitySecretKey(runtimeSecrets),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    CAPABILITY_SECRET_PREFIX.slice(0, -1),
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptCapabilitySecretValue(
  stored: string,
  runtimeSecrets: RuntimeSecretProvider,
): string {
  if (!stored.startsWith(CAPABILITY_SECRET_PREFIX)) {
    throw new Error('Gantry Secret is not encrypted. Rotate it before use.');
  }
  const [_enc, _v1, ivRaw, tagRaw, ciphertextRaw] = stored.split(':');
  if (!ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error('Gantry Secret ciphertext is malformed.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    resolveCapabilitySecretKey(runtimeSecrets),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
