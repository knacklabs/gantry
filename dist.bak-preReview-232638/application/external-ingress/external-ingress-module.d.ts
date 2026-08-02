import { JobManagementService } from '../jobs/job-management-service.js';
import type { SessionInteractionModule } from '../sessions/session-interaction-module.js';
import type { ConversationMessageIngressModule } from './conversation-message-ingress.js';
import { EXTERNAL_INGRESS_RUNTIME_DISPATCH, type SessionGroupRegistration } from './runtime-dispatch.js';
import { type ExternalIngressSignaturePort } from './signature.js';
type ExternalIngressRecord = {
    ingressId: string;
    appId: string;
    name: string;
    secret: string;
    enabled: boolean;
    metadata: unknown;
    createdAt: string;
    updatedAt: string;
};
type ExternalIngressControlPort = {
    createExternalIngress(input: {
        appId: string;
        name: string;
        secret: string;
        enabled?: boolean;
        metadata?: unknown;
    }): Promise<ExternalIngressRecord>;
    listExternalIngresses(appId: string): Promise<ExternalIngressRecord[]>;
    getExternalIngressById(ingressId: string, appId?: string): Promise<ExternalIngressRecord | undefined>;
    updateExternalIngress(ingressId: string, appId: string, patch: {
        name?: string;
        secret?: string;
        enabled?: boolean;
        metadata?: unknown;
    }): Promise<ExternalIngressRecord | undefined>;
    deleteExternalIngress(ingressId: string, appId: string): Promise<boolean>;
    reserveExternalIngressNonce(input: {
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
    createExternalIngressInvocation(input: {
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
        row?: ExternalIngressInvocationRecord;
    }>;
    getExternalIngressInvocationByIdempotencyKey(input: {
        appId: string;
        ingressId: string;
        idempotencyKey: string;
    }): Promise<ExternalIngressInvocationRecord | undefined>;
    updateExternalIngressInvocation(input: {
        invocationId: string;
        status: string;
        response?: unknown;
        error?: string | null;
        now: string;
    }): Promise<void>;
    getExternalIngressInvocation(invocationId: string, appId: string, ingressId: string): Promise<ExternalIngressInvocationRecord | undefined>;
};
type ExternalIngressInvocationRecord = {
    invocationId: string;
    status: string;
    bodyHash: string;
    response: unknown;
    error: string | null;
    updatedAt: string;
};
type ConversationMessageProjectionPort = {
    send(input: {
        conversationJid: string;
        threadId: string | null;
        providerAccountId: string;
        text: string;
    }): Promise<void>;
};
export declare class ExternalIngressModule {
    private readonly deps;
    constructor(deps: {
        control: ExternalIngressControlPort;
        sessions: SessionInteractionModule;
        registerSessionGroup?: (registration: SessionGroupRegistration) => Promise<void>;
        conversationMessages?: ConversationMessageIngressModule;
        conversationProviderMessages?: ConversationMessageProjectionPort;
        jobs: JobManagementService;
        now: () => string;
        createSecret: () => string;
        createInvocationId: () => string;
        signatureCrypto: ExternalIngressSignaturePort;
        consumeTriggerRateLimit?: (key: string, limit: number) => boolean;
        perAppTriggerLimit: number;
        perJobTriggerLimit: number;
    });
    create(input: {
        appId: string;
        name: string;
        enabled?: boolean;
        metadata?: unknown;
    }): Promise<{
        secret: string;
        ingressId: string;
        appId: string;
        name: string;
        enabled: boolean;
        metadata: unknown;
        createdAt: string;
        updatedAt: string;
    }>;
    list(appId: string): Promise<{
        ingresses: {
            ingressId: string;
            appId: string;
            name: string;
            enabled: boolean;
            metadata: unknown;
            createdAt: string;
            updatedAt: string;
        }[];
    }>;
    get(input: {
        appId: string;
        ingressId: string;
    }): Promise<{
        ingressId: string;
        appId: string;
        name: string;
        enabled: boolean;
        metadata: unknown;
        createdAt: string;
        updatedAt: string;
    }>;
    update(input: {
        appId: string;
        ingressId: string;
        patch: {
            name?: string;
            enabled?: boolean;
            metadata?: unknown;
        };
    }): Promise<{
        ingressId: string;
        appId: string;
        name: string;
        enabled: boolean;
        metadata: unknown;
        createdAt: string;
        updatedAt: string;
    }>;
    rotate(input: {
        appId: string;
        ingressId: string;
    }): Promise<{
        secret: string;
        ingressId: string;
        appId: string;
        name: string;
        enabled: boolean;
        metadata: unknown;
        createdAt: string;
        updatedAt: string;
    }>;
    delete(input: {
        appId: string;
        ingressId: string;
    }): Promise<{
        deleted: boolean;
    }>;
    invoke(input: {
        ingressId: string;
        method: string;
        path: string;
        timestamp: string;
        nonce: string;
        signature: string;
        rawBody: string;
    }): Promise<{
        error?: string | undefined;
        invocationId: string;
        duplicate: boolean;
        status: string;
    } | {
        enqueue: {
            conversationJid: string;
            threadId: string | null;
            queueKey: string;
        };
        [EXTERNAL_INGRESS_RUNTIME_DISPATCH]: {
            enqueue: import("../sessions/session-interaction-module.js").SessionQueueIntent;
            localEnqueue: boolean;
        };
        registerGroup?: {
            conversationJid: string;
            group: {
                name: string;
                folder: string;
                trigger: string;
                added_at: string;
                requiresTrigger: boolean;
            };
        } | undefined;
        targetKind: string;
        sessionId: string;
        messageId: string;
        acceptedEventId: number;
        wait: {
            kind: string;
            sessionId: string;
            afterEventId: number;
        };
        invocationId: string;
        duplicate: boolean;
    } | {
        targetKind: string;
        conversationId: string;
        threadId: string | null;
        messageId: string;
        acceptedEventId: number;
        [EXTERNAL_INGRESS_RUNTIME_DISPATCH]: {
            enqueue: import("./conversation-message-ingress.js").ConversationMessageQueueIntent;
            localEnqueue: boolean;
        };
        invocationId: string;
        duplicate: boolean;
    } | {
        targetKind: string;
        jobId: string;
        triggerId: string;
        wait: {
            kind: string;
            triggerId: string;
        };
        invocationId: string;
        duplicate: boolean;
    }>;
    wait(input: {
        ingressId: string;
        invocationId: string;
    }): Promise<ExternalIngressInvocationRecord>;
    signedWait(input: {
        ingressId: string;
        method: string;
        path: string;
        timestamp: string;
        nonce: string;
        signature: string;
        rawBody: string;
    }): Promise<ExternalIngressInvocationRecord>;
    private dispatchTarget;
    private invokeSessionMessage;
    private invokeConversationMessage;
    private invokeJobTrigger;
    private invokeJobTemplate;
    private markInvocationFailed;
}
export {};
