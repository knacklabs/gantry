import type { AppId } from '../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { CapabilitySecretRepository } from '../../domain/ports/repositories.js';
import type { McpCredentialRef } from '../../domain/mcp/mcp-servers.js';
import {
  assertValidCapabilitySecretName,
  normalizeCapabilitySecretName,
} from '../../domain/capability-secrets/capability-secrets.js';
import { formatMissingGantrySecretsMessage } from '../../shared/user-visible-messages.js';

export type CapabilitySecretStatus = 'ready' | 'needs_secret';
type CapabilitySecretAuditPublisher = (
  event: RuntimeEventPublishInput,
) => Promise<unknown> | unknown;

export class CapabilitySecretService {
  constructor(
    private readonly secrets: CapabilitySecretRepository,
    private readonly audit?: CapabilitySecretAuditPublisher,
  ) {}

  async list(input: { appId: AppId }) {
    return this.secrets.listSecrets(input);
  }

  async status(input: {
    appId: AppId;
    name: string;
  }): Promise<CapabilitySecretStatus> {
    const name = normalizeCapabilitySecretName(input.name);
    assertValidCapabilitySecretName(name);
    const secret = await this.secrets.getSecret({
      appId: input.appId,
      name,
    });
    return secret?.value ? 'ready' : 'needs_secret';
  }

  async set(input: {
    appId: AppId;
    name: string;
    value: string;
    actor?: string;
    allowedCapabilityIds?: string[];
  }) {
    const name = normalizeCapabilitySecretName(input.name);
    assertValidCapabilitySecretName(name);
    const metadata = await this.secrets.upsertSecret({
      appId: input.appId,
      name,
      value: input.value,
      actor: input.actor,
      allowedCapabilityIds: input.allowedCapabilityIds,
    });
    await this.publishAudit({
      appId: input.appId,
      actor: input.actor ?? 'capability-secret-service',
      eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_CAPABILITY_UPDATED,
      payload: {
        name: metadata.name,
        allowedCapabilityIds: metadata.allowedCapabilityIds,
        updatedAt: metadata.updatedAt,
      },
    });
    return metadata;
  }

  async unset(input: {
    appId: AppId;
    name: string;
    actor?: string;
  }): Promise<boolean> {
    const name = normalizeCapabilitySecretName(input.name);
    assertValidCapabilitySecretName(name);
    const deleted = await this.secrets.deleteSecret({
      appId: input.appId,
      name,
    });
    if (deleted) {
      await this.publishAudit({
        appId: input.appId,
        actor: input.actor ?? 'capability-secret-service',
        eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_CAPABILITY_REMOVED,
        payload: { name },
      });
    }
    return deleted;
  }

  async resolveEnv(input: {
    appId: AppId;
    names: readonly string[];
    allowedCapabilityIds?: readonly string[];
  }): Promise<{
    env: Record<string, string>;
    missing: string[];
  }> {
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const rawName of uniqueNames(input.names)) {
      const name = normalizeCapabilitySecretName(rawName);
      assertValidCapabilitySecretName(name);
      const secret = await this.secrets.getSecret({
        appId: input.appId,
        name,
      });
      if (!secret?.value) {
        missing.push(name);
        continue;
      }
      if (
        secret.allowedCapabilityIds.length > 0 &&
        !secret.allowedCapabilityIds.some((capabilityId) =>
          (input.allowedCapabilityIds ?? []).includes(capabilityId),
        )
      ) {
        missing.push(name);
        continue;
      }
      env[name] = secret.value;
    }
    return { env, missing };
  }

  async resolveMcpCredentialRefs(input: {
    appId: AppId;
    refs: readonly McpCredentialRef[];
    allowedCapabilityIds?: readonly string[];
  }): Promise<{
    credentialEnv: Record<string, string>;
    missing: string[];
  }> {
    const resolved = await this.resolveEnv({
      appId: input.appId,
      names: input.refs.map((ref) => ref.name),
      allowedCapabilityIds: input.allowedCapabilityIds,
    });
    return { credentialEnv: resolved.env, missing: resolved.missing };
  }

  private async publishAudit(input: RuntimeEventPublishInput): Promise<void> {
    if (!this.audit) return;
    await this.audit(input);
  }
}

export function missingSecretMessage(names: readonly string[]): string {
  return formatMissingGantrySecretsMessage(uniqueNames(names));
}

function uniqueNames(names: readonly string[]): string[] {
  return [
    ...new Set(
      names
        .map(normalizeCapabilitySecretName)
        .filter((name) => name.length > 0),
    ),
  ];
}
