import type { AppResponseRouteRecord, AppSessionRecord, ClaimedWebhookDeliveryRecord, ControlResponseMode, JobTriggerRecord, WebhookDeliveryRecord, WebhookRegistrationRecord } from '../schema/control-plane-records.postgres.js';
import { type CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresControlPlaneRepository {
    private readonly db;
    private readonly externalIngress;
    private readonly jobTriggers;
    constructor(db: CanonicalDb);
    ensureAppSession(input: {
        appId: string;
        conversationId: string;
        chatJid: string;
        workspaceFolder: string;
        title?: string | null;
        defaultResponseMode?: ControlResponseMode;
        defaultWebhookId?: string | null;
    }): Promise<AppSessionRecord>;
    getAppSessionById(sessionId: string): Promise<AppSessionRecord | undefined>;
    getAppSessionsByIds(sessionIds: readonly string[]): Promise<AppSessionRecord[]>;
    getAppSessionByChatJid(chatJid: string): Promise<AppSessionRecord | undefined>;
    getAppSessionsByChatJids(chatJids: readonly string[]): Promise<AppSessionRecord[]>;
    upsertAppResponseRoute(input: {
        sessionId: string;
        threadId?: string | null;
        responseMode: ControlResponseMode;
        webhookId?: string | null;
        correlationId?: string | null;
    }): Promise<AppResponseRouteRecord>;
    getAppResponseRoute(input: {
        sessionId: string;
        threadId?: string | null;
    }): Promise<AppResponseRouteRecord | undefined>;
    createExternalIngress(input: {
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
    listExternalIngresses(appId: string): Promise<{
        ingressId: string;
        appId: string;
        name: string;
        secret: string;
        enabled: boolean;
        metadata: {};
        createdAt: string;
        updatedAt: string;
    }[]>;
    getExternalIngressById(ingressId: string, appId?: string): Promise<{
        ingressId: string;
        appId: string;
        name: string;
        secret: string;
        enabled: boolean;
        metadata: {};
        createdAt: string;
        updatedAt: string;
    } | undefined>;
    updateExternalIngress(ingressId: string, appId: string, patch: {
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
        row: {
            invocationId: string;
            status: string;
            bodyHash: string;
            response: null;
            error: string | null;
            updatedAt: string;
        } | undefined;
    }>;
    getExternalIngressInvocationByIdempotencyKey(input: {
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
    updateExternalIngressInvocation(input: {
        invocationId: string;
        status: string;
        response?: unknown;
        error?: string | null;
        now: string;
    }): Promise<void>;
    getExternalIngressInvocation(invocationId: string, appId: string, ingressId: string): Promise<{
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
    sweepExpiredExternalIngressState(input: {
        now: string;
    }): Promise<{
        noncesDeleted: number;
        invocationsDeleted: number;
        stalePendingFailed: number;
    }>;
    registerWebhook(input: {
        webhookId?: string;
        appId: string;
        name: string;
        url: string;
        secret: string;
        enabled?: boolean;
        eventTypes?: readonly string[] | null;
        agentId?: string | null;
        sessionId?: string | null;
        jobId?: string | null;
    }): Promise<WebhookRegistrationRecord>;
    getWebhookById(webhookId: string, appId?: string): Promise<(WebhookRegistrationRecord & {
        secret: string;
    }) | undefined>;
    listWebhooks(appId?: string): Promise<WebhookRegistrationRecord[]>;
    updateWebhook(webhookId: string, appId: string, patch: {
        name?: string;
        url?: string;
        secret?: string;
        enabled?: boolean;
        eventTypes?: readonly string[] | null;
        agentId?: string | null;
        sessionId?: string | null;
        jobId?: string | null;
    }): Promise<WebhookRegistrationRecord | undefined>;
    deleteWebhook(webhookId: string, appId?: string): Promise<void>;
    enqueueWebhookDelivery(eventId: number, webhookId: string): Promise<WebhookDeliveryRecord>;
    listDueWebhookDeliveries(limit?: number): Promise<WebhookDeliveryRecord[]>;
    claimDueWebhookDeliveries(limit?: number): Promise<ClaimedWebhookDeliveryRecord[]>;
    markWebhookDeliveryDelivered(deliveryId: string): Promise<void>;
    markWebhookDeliveryDelivering(input: {
        deliveryId: string;
        attemptCount: number;
        nextAttemptAt: string;
    }): Promise<void>;
    markWebhookDeliveryRetry(input: {
        deliveryId: string;
        nextAttemptAt: string;
        lastError: string;
    }): Promise<void>;
    markWebhookDeliveryDead(deliveryId: string, lastError: string): Promise<void>;
    replayWebhookDeadLetters(webhookId: string, appId: string): Promise<number>;
    purgeWebhookDeadLetters(webhookId: string, appId: string): Promise<number>;
    createJobTrigger(input: {
        jobId: string;
        requestedBy?: string;
    }): Promise<JobTriggerRecord>;
    bindPendingTriggerToRun(jobId: string, runId: string): Promise<JobTriggerRecord | undefined>;
    bindTriggerToRun(triggerId: string, runId: string): Promise<JobTriggerRecord | undefined>;
    markTriggerCompleted(triggerId: string, status: 'completed' | 'failed'): Promise<void>;
    getTriggerById(triggerId: string): Promise<JobTriggerRecord | undefined>;
}
