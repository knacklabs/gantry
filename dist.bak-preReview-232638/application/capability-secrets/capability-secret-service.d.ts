import type { AppId } from '../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { CapabilitySecretRepository } from '../../domain/ports/repositories.js';
import type { McpCredentialRef } from '../../domain/mcp/mcp-servers.js';
export type CapabilitySecretStatus = 'ready' | 'needs_secret';
type CapabilitySecretAuditPublisher = (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
export declare class CapabilitySecretService {
    private readonly secrets;
    private readonly audit?;
    constructor(secrets: CapabilitySecretRepository, audit?: CapabilitySecretAuditPublisher | undefined);
    list(input: {
        appId: AppId;
    }): Promise<import("../../domain/capability-secrets/capability-secrets.js").CapabilitySecretMetadata[]>;
    status(input: {
        appId: AppId;
        name: string;
    }): Promise<CapabilitySecretStatus>;
    set(input: {
        appId: AppId;
        name: string;
        value: string;
        actor?: string;
        allowedCapabilityIds?: string[];
    }): Promise<import("../../domain/capability-secrets/capability-secrets.js").CapabilitySecretMetadata>;
    unset(input: {
        appId: AppId;
        name: string;
        actor?: string;
    }): Promise<boolean>;
    resolveEnv(input: {
        appId: AppId;
        names: readonly string[];
        allowedCapabilityIds?: readonly string[];
    }): Promise<{
        env: Record<string, string>;
        missing: string[];
    }>;
    resolveMcpCredentialRefs(input: {
        appId: AppId;
        refs: readonly McpCredentialRef[];
        allowedCapabilityIds?: readonly string[];
    }): Promise<{
        credentialEnv: Record<string, string>;
        missing: string[];
    }>;
    private publishAudit;
}
export declare function missingSecretMessage(names: readonly string[]): string;
export {};
