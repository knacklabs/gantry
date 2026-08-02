import type { RuntimeSecretProvider } from '../../../../domain/ports/runtime-secret-provider.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresExternalIngressRepository {
    private readonly db;
    private readonly runtimeSecrets;
    constructor(db: CanonicalDb, runtimeSecrets?: RuntimeSecretProvider);
    create(input: {
        ingressId?: string;
        appId: string;
        name: string;
        secret: string;
        enabled?: boolean;
        metadata?: unknown;
    }): Promise<{
        ingressId: string;
        appId: string;
        name: string;
        secret: string;
        enabled: boolean;
        metadata: {};
        createdAt: string;
        updatedAt: string;
    }>;
    list(appId: string): Promise<{
        ingressId: string;
        appId: string;
        name: string;
        secret: string;
        enabled: boolean;
        metadata: {};
        createdAt: string;
        updatedAt: string;
    }[]>;
    getById(ingressId: string, appId?: string): Promise<{
        ingressId: string;
        appId: string;
        name: string;
        secret: string;
        enabled: boolean;
        metadata: {};
        createdAt: string;
        updatedAt: string;
    } | undefined>;
    update(ingressId: string, appId: string, patch: {
        name?: string;
        secret?: string;
        enabled?: boolean;
        metadata?: unknown;
    }): Promise<{
        ingressId: string;
        appId: string;
        name: string;
        secret: string;
        enabled: boolean;
        metadata: {};
        createdAt: string;
        updatedAt: string;
    } | undefined>;
    delete(ingressId: string, appId: string): Promise<boolean>;
    reserveNonce(input: {
        appId: string;
        ingressId: string;
        nonce: string;
        now: string;
        expiresAt: string;
    }): Promise<{
        ok: true;
    } | {
        ok: false;
        code: 'NONCE_REPLAY';
    }>;
    createInvocation(input: {
        invocationId: string;
        appId: string;
        ingressId: string;
        idempotencyKey: string;
        nonce: string;
        requestMethod: string;
        requestPath: string;
        requestTimestamp: string;
        bodyHash: string;
        requestBody: string;
        signature: string;
        status: string;
        now: string;
        expiresAt: string;
    }): Promise<{
        created: boolean;
        row: {
            invocationId: string;
            status: string;
            bodyHash: string;
            response: null;
            error: string | null;
            updatedAt: string;
        } | undefined;
    }>;
    getInvocationByIdempotencyKey(input: {
        appId: string;
        ingressId: string;
        idempotencyKey: string;
    }): Promise<{
        invocationId: string;
        status: string;
        bodyHash: string;
        response: null;
        error: string | null;
        updatedAt: string;
    } | undefined>;
    updateInvocation(input: {
        invocationId: string;
        status: string;
        response?: unknown;
        error?: string | null;
        now: string;
    }): Promise<void>;
    getInvocation(invocationId: string, appId: string, ingressId: string): Promise<{
        invocationId: string;
        appId: string;
        ingressId: string;
        idempotencyKey: string;
        status: string;
        bodyHash: string;
        response: null;
        error: string | null;
        createdAt: string;
        updatedAt: string;
    } | undefined>;
    sweepExpiredState(input: {
        now: string;
    }): Promise<{
        noncesDeleted: number;
        invocationsDeleted: number;
        stalePendingFailed: number;
    }>;
}
export declare function resolveExternalIngressSecretKey(runtimeSecrets: RuntimeSecretProvider): Buffer;
export declare function encryptExternalIngressSecret(secret: string, runtimeSecrets: RuntimeSecretProvider): string;
export declare function decryptExternalIngressSecret(stored: string, runtimeSecrets: RuntimeSecretProvider): string;
