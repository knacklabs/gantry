import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { sha256Hex, stableSha256Json } from '../../shared/stable-hash.js';
import { listSupportedModelCredentialProviders, normalizeModelCredentialProvider, } from '../../domain/model-credentials/model-credentials.js';
import { getModelProviderDefinition, normalizeModelCredentialPayload, normalizePartialModelCredentialPayload, resolveModelCredentialMode, } from '../../shared/model-provider-registry.js';
export class ModelCredentialService {
    credentials;
    audit;
    constructor(credentials, audit) {
        this.credentials = credentials;
        this.audit = audit;
    }
    async list(input) {
        const configured = new Map((await this.credentials.listModelCredentials(input)).map((credential) => [
            credential.providerId,
            credential,
        ]));
        return listSupportedModelCredentialProviders().map((providerId) => {
            const credential = configured.get(providerId);
            const health = credential?.status === 'active'
                ? 'ready'
                : credential
                    ? 'disabled'
                    : 'missing';
            return {
                providerId,
                label: getModelProviderDefinition(providerId)?.label ?? providerId,
                role: providerRole(getModelProviderDefinition(providerId)),
                configured: health === 'ready',
                authMode: credential?.authMode ?? null,
                status: credential?.status ?? 'disabled',
                health,
                fingerprint: credential?.fingerprint ?? null,
                fieldFingerprints: credential?.fieldFingerprints ?? [],
                schemaVersion: credential?.schemaVersion ??
                    getModelProviderDefinition(providerId)?.credentialModes[0]?.version ??
                    1,
                configuredFields: credential?.fieldFingerprints.map((item) => item.field) ?? [],
                credentialModes: credentialModeMetadata(getModelProviderDefinition(providerId)),
                supportedWorkloads: getModelProviderDefinition(providerId)?.supportedWorkloads ?? [],
                updatedAt: credential?.updatedAt ?? null,
            };
        });
    }
    async set(input) {
        const providerId = normalizeModelCredentialProvider(input.providerId);
        const provider = getModelProviderDefinition(providerId);
        if (!provider)
            throw new Error(`Unsupported model provider: ${providerId}`);
        const mode = resolveModelCredentialMode(provider, input.authMode);
        const payload = normalizeModelCredentialPayload({
            providerId,
            authMode: mode.id,
            payload: input.payload,
        });
        const schemaVersion = mode.version;
        const fieldFingerprints = fingerprintCredentialFields(providerId, mode.id, payload);
        const metadata = await this.credentials.upsertModelCredential({
            appId: input.appId,
            providerId,
            authMode: mode.id,
            schemaVersion,
            payload,
            fingerprint: fingerprintCredentialPayload(payload),
            fieldFingerprints,
            actor: input.actor,
        });
        await this.publishAudit({
            appId: input.appId,
            actor: input.actor ?? 'model-credential-service',
            eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_UPDATED,
            payload: {
                providerId: metadata.providerId,
                authMode: metadata.authMode,
                status: metadata.status,
                fingerprint: metadata.fingerprint,
                fieldFingerprints: metadata.fieldFingerprints,
                schemaVersion: metadata.schemaVersion,
                updatedAt: metadata.updatedAt,
            },
        });
        return metadata;
    }
    async rotate(input) {
        const providerId = normalizeModelCredentialProvider(input.providerId);
        const existing = await this.credentials.getModelCredential({
            appId: input.appId,
            providerId,
        });
        if (!existing) {
            throw new Error(`No ${providerId} model credential is configured.`);
        }
        if (existing.status !== 'active') {
            throw new Error(`Cannot rotate disabled ${providerId} model credential.`);
        }
        const partial = normalizePartialModelCredentialPayload({
            providerId,
            authMode: existing.authMode,
            payload: input.payload,
        });
        const payload = normalizeModelCredentialPayload({
            providerId,
            authMode: existing.authMode,
            payload: { ...existing.payload, ...partial },
        });
        const provider = getModelProviderDefinition(providerId);
        if (!provider)
            throw new Error(`Unsupported model provider: ${providerId}`);
        const mode = resolveModelCredentialMode(provider, existing.authMode);
        const metadata = await this.credentials.upsertModelCredential({
            appId: input.appId,
            providerId,
            authMode: mode.id,
            schemaVersion: mode.version,
            payload,
            fingerprint: fingerprintCredentialPayload(payload),
            fieldFingerprints: fingerprintCredentialFields(providerId, mode.id, payload),
            actor: input.actor,
        });
        await this.publishAudit({
            appId: input.appId,
            actor: input.actor ?? 'model-credential-service',
            eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_UPDATED,
            payload: {
                providerId: metadata.providerId,
                authMode: metadata.authMode,
                status: metadata.status,
                fingerprint: metadata.fingerprint,
                fieldFingerprints: metadata.fieldFingerprints,
                schemaVersion: metadata.schemaVersion,
                updatedAt: metadata.updatedAt,
            },
        });
        return metadata;
    }
    async disable(input) {
        const providerId = normalizeModelCredentialProvider(input.providerId);
        const metadata = await this.credentials.disableModelCredential({
            appId: input.appId,
            providerId,
            actor: input.actor,
        });
        if (metadata) {
            await this.publishAudit({
                appId: input.appId,
                actor: input.actor ?? 'model-credential-service',
                eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_DISABLED,
                payload: {
                    providerId: metadata.providerId,
                    authMode: metadata.authMode,
                    status: metadata.status,
                    fingerprint: metadata.fingerprint,
                    fieldFingerprints: metadata.fieldFingerprints,
                    schemaVersion: metadata.schemaVersion,
                    updatedAt: metadata.updatedAt,
                },
            });
        }
        return metadata;
    }
    async getActiveCredential(input) {
        const credential = await this.credentials.getModelCredential(input);
        if (!credential || credential.status !== 'active')
            return null;
        return credential;
    }
    // Provider ids (route ids) that currently have an ACTIVE configured
    // credential for this app. Used to drive credential-based model-family
    // provider selection at the spawn/job seams; only active credentials count.
    async getConfiguredModelProviders(input) {
        const credentials = await this.credentials.listModelCredentials(input);
        return new Set(credentials
            .filter((credential) => credential.status === 'active')
            .map((credential) => credential.providerId));
    }
    async publishAudit(input) {
        if (!this.audit)
            return;
        await this.audit(input);
    }
}
export function fingerprintCredential(value) {
    const digest = sha256Hex(value);
    return `sha256:${digest.slice(0, 16)}`;
}
export function fingerprintCredentialPayload(payload) {
    return `sha256:${stableSha256Json(payload).slice(0, 16)}`;
}
function fingerprintCredentialFields(providerId, authMode, payload) {
    const provider = getModelProviderDefinition(providerId);
    const mode = provider ? resolveModelCredentialMode(provider, authMode) : null;
    return (mode?.fields ?? [])
        .filter((field) => payload[field.name])
        .map((field) => ({
        field: field.name,
        fingerprint: fingerprintCredential(payload[field.name]),
    }));
}
function providerRole(provider) {
    if (!provider)
        return 'provider';
    if (provider.modelRoute)
        return 'model_route';
    if (provider.embeddingProvider)
        return 'embedding_provider';
    return 'provider';
}
function credentialModeMetadata(provider) {
    return (provider?.credentialModes ?? []).map((mode) => ({
        id: mode.id,
        label: mode.label,
        helpText: mode.helpText,
        schemaVersion: mode.version,
        gatewayAuthStrategy: mode.gatewayAuth.strategy,
        fields: mode.fields.map((field) => ({
            name: field.name,
            label: field.label,
            secret: field.secret,
            required: field.required,
        })),
    }));
}
