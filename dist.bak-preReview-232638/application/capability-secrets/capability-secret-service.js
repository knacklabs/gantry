import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { assertValidCapabilitySecretName, normalizeCapabilitySecretName, } from '../../domain/capability-secrets/capability-secrets.js';
import { formatMissingGantrySecretsMessage } from '../../shared/user-visible-messages.js';
export class CapabilitySecretService {
    secrets;
    audit;
    constructor(secrets, audit) {
        this.secrets = secrets;
        this.audit = audit;
    }
    async list(input) {
        return this.secrets.listSecrets(input);
    }
    async status(input) {
        const name = normalizeCapabilitySecretName(input.name);
        assertValidCapabilitySecretName(name);
        const secret = await this.secrets.getSecret({
            appId: input.appId,
            name,
        });
        return secret?.value ? 'ready' : 'needs_secret';
    }
    async set(input) {
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
    async unset(input) {
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
    async resolveEnv(input) {
        const env = {};
        const missing = [];
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
            if (secret.allowedCapabilityIds.length > 0 &&
                !secret.allowedCapabilityIds.some((capabilityId) => (input.allowedCapabilityIds ?? []).includes(capabilityId))) {
                missing.push(name);
                continue;
            }
            env[name] = secret.value;
        }
        return { env, missing };
    }
    async resolveMcpCredentialRefs(input) {
        const resolved = await this.resolveEnv({
            appId: input.appId,
            names: input.refs.map((ref) => ref.name),
            allowedCapabilityIds: input.allowedCapabilityIds,
        });
        return { credentialEnv: resolved.env, missing: resolved.missing };
    }
    async publishAudit(input) {
        if (!this.audit)
            return;
        await this.audit(input);
    }
}
export function missingSecretMessage(names) {
    return formatMissingGantrySecretsMessage(uniqueNames(names));
}
function uniqueNames(names) {
    return [
        ...new Set(names
            .map(normalizeCapabilitySecretName)
            .filter((name) => name.length > 0)),
    ];
}
