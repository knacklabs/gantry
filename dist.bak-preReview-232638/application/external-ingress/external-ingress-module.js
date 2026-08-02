import { ApplicationError } from '../common/application-error.js';
import { EXTERNAL_INGRESS_RUNTIME_DISPATCH, toPublicSessionQueueIntent, } from './runtime-dispatch.js';
import { verifyExternalIngressRequestSignature, } from './signature.js';
import { assertTargetAllowed, readOptionalString, readString, readTemplate, readVariables, renderTemplate, validateIngressMetadata, } from './target-policy.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
export class ExternalIngressModule {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async create(input) {
        if (!input.name.trim()) {
            throw new ApplicationError('INVALID_REQUEST', 'name is required');
        }
        const secret = this.deps.createSecret();
        const metadata = validateIngressMetadata(input.metadata ?? {});
        const ingress = await this.deps.control.createExternalIngress({
            appId: input.appId,
            name: input.name.trim(),
            secret,
            enabled: input.enabled ?? true,
            metadata,
        });
        return { ...publicIngress(ingress), secret };
    }
    async list(appId) {
        const ingresses = await this.deps.control.listExternalIngresses(appId);
        return { ingresses: ingresses.map(publicIngress) };
    }
    async get(input) {
        const ingress = await this.deps.control.getExternalIngressById(input.ingressId, input.appId);
        if (!ingress)
            throw new ApplicationError('NOT_FOUND', 'Ingress not found');
        return publicIngress(ingress);
    }
    async update(input) {
        const patch = {
            ...input.patch,
            ...(input.patch.metadata !== undefined
                ? { metadata: validateIngressMetadata(input.patch.metadata) }
                : {}),
        };
        const ingress = await this.deps.control.updateExternalIngress(input.ingressId, input.appId, patch);
        if (!ingress)
            throw new ApplicationError('NOT_FOUND', 'Ingress not found');
        return publicIngress(ingress);
    }
    async rotate(input) {
        const secret = this.deps.createSecret();
        const ingress = await this.deps.control.updateExternalIngress(input.ingressId, input.appId, { secret });
        if (!ingress)
            throw new ApplicationError('NOT_FOUND', 'Ingress not found');
        return { ...publicIngress(ingress), secret };
    }
    async delete(input) {
        const deleted = await this.deps.control.deleteExternalIngress(input.ingressId, input.appId);
        if (!deleted)
            throw new ApplicationError('NOT_FOUND', 'Ingress not found');
        return { deleted: true };
    }
    async invoke(input) {
        const ingress = await this.deps.control.getExternalIngressById(input.ingressId);
        if (!ingress)
            throw new ApplicationError('NOT_FOUND', 'Ingress not found');
        if (!ingress.enabled) {
            throw new ApplicationError('FORBIDDEN', 'Ingress is disabled');
        }
        const ok = verifyExternalIngressRequestSignature({
            crypto: this.deps.signatureCrypto,
            secret: ingress.secret,
            method: input.method,
            path: input.path,
            timestamp: input.timestamp,
            nonce: input.nonce,
            rawBody: input.rawBody,
            signature: input.signature,
        });
        if (!ok) {
            throw new ApplicationError('FORBIDDEN', 'Invalid external ingress signature');
        }
        const body = parseBody(input.rawBody);
        const assertedAppId = typeof body.appId === 'string' && body.appId.trim()
            ? body.appId.trim()
            : null;
        if (assertedAppId && assertedAppId !== ingress.appId) {
            throw new ApplicationError('FORBIDDEN', 'Request appId does not match ingress app scope');
        }
        const timestampMs = Number(input.timestamp);
        const now = this.deps.now();
        const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
            ? body.idempotencyKey.trim()
            : input.nonce;
        const bodyHash = this.deps.signatureCrypto.sha256(input.rawBody);
        const existing = await this.deps.control.getExternalIngressInvocationByIdempotencyKey({
            appId: ingress.appId,
            ingressId: ingress.ingressId,
            idempotencyKey,
        });
        if (existing) {
            assertSameIdempotencyBody(existing, bodyHash);
            if (existing.status === 'pending') {
                throw new ApplicationError('CONFLICT', 'Duplicate active external ingress invocation');
            }
            return duplicateInvocationResponse(existing);
        }
        const nonceExpiry = new Date(timestampMs + 5 * 60_000).toISOString();
        const nonce = await this.deps.control.reserveExternalIngressNonce({
            appId: ingress.appId,
            ingressId: ingress.ingressId,
            nonce: input.nonce,
            now,
            expiresAt: nonceExpiry,
        });
        if (!nonce.ok) {
            throw new ApplicationError('CONFLICT', 'External ingress nonce replay');
        }
        const invocationId = this.deps.createInvocationId();
        const invocation = await this.deps.control.createExternalIngressInvocation({
            invocationId,
            appId: ingress.appId,
            ingressId: ingress.ingressId,
            idempotencyKey,
            nonce: input.nonce,
            requestMethod: input.method.toUpperCase(),
            requestPath: input.path,
            requestTimestamp: new Date(timestampMs).toISOString(),
            bodyHash,
            requestBody: `sha256:${bodyHash}`,
            signature: 'redacted',
            status: 'pending',
            now,
            expiresAt: addDaysIso(now, 7),
        });
        if (!invocation.row) {
            throw new ApplicationError('CONFLICT', 'External ingress invocation conflict; retry request');
        }
        if (!invocation.created) {
            assertSameIdempotencyBody(invocation.row, bodyHash);
        }
        if (!invocation.created && invocation.row.status === 'pending') {
            throw new ApplicationError('CONFLICT', 'Duplicate active external ingress invocation');
        }
        if (!invocation.created) {
            return duplicateInvocationResponse(invocation.row);
        }
        try {
            const result = await this.dispatchTarget({
                appId: ingress.appId,
                invocationId,
                metadata: ingress.metadata,
                body,
            });
            await this.deps.control.updateExternalIngressInvocation({
                invocationId,
                status: 'completed',
                response: result,
                now: this.deps.now(),
            });
            return { invocationId, duplicate: false, ...result };
        }
        catch (error) {
            await this.markInvocationFailed(invocationId, error);
            throw error;
        }
    }
    async wait(input) {
        const ingress = await this.deps.control.getExternalIngressById(input.ingressId);
        if (!ingress)
            throw new ApplicationError('NOT_FOUND', 'Ingress not found');
        const invocation = await this.deps.control.getExternalIngressInvocation(input.invocationId, ingress.appId, ingress.ingressId);
        if (!invocation) {
            throw new ApplicationError('NOT_FOUND', 'Invocation not found');
        }
        return invocation;
    }
    async signedWait(input) {
        const ingress = await this.deps.control.getExternalIngressById(input.ingressId);
        if (!ingress)
            throw new ApplicationError('NOT_FOUND', 'Ingress not found');
        if (!ingress.enabled) {
            throw new ApplicationError('FORBIDDEN', 'Ingress is disabled');
        }
        const ok = verifyExternalIngressRequestSignature({
            crypto: this.deps.signatureCrypto,
            secret: ingress.secret,
            method: input.method,
            path: input.path,
            timestamp: input.timestamp,
            nonce: input.nonce,
            rawBody: input.rawBody,
            signature: input.signature,
        });
        if (!ok) {
            throw new ApplicationError('FORBIDDEN', 'Invalid external ingress signature');
        }
        const timestampMs = Number(input.timestamp);
        const nonce = await this.deps.control.reserveExternalIngressNonce({
            appId: ingress.appId,
            ingressId: ingress.ingressId,
            nonce: input.nonce,
            now: this.deps.now(),
            expiresAt: new Date(timestampMs + 5 * 60_000).toISOString(),
        });
        if (!nonce.ok) {
            throw new ApplicationError('CONFLICT', 'External ingress nonce replay');
        }
        const body = parseBody(input.rawBody);
        const invocationId = readString(body, 'invocationId');
        return this.wait({ ingressId: input.ingressId, invocationId });
    }
    async dispatchTarget(input) {
        const target = readTarget(input.body);
        assertTargetAllowed(input.metadata, target);
        if (target.kind === 'session_message') {
            return this.invokeSessionMessage(input.appId, target);
        }
        if (target.kind === 'conversation_message') {
            return this.invokeConversationMessage(input.appId, input.invocationId, target);
        }
        if (target.kind === 'job_trigger') {
            return this.invokeJobTrigger(input.appId, target);
        }
        if (target.kind === 'job_template') {
            return this.invokeJobTemplate(input.appId, input.metadata, target);
        }
        throw new ApplicationError('INVALID_REQUEST', 'Unsupported ingress target');
    }
    async invokeSessionMessage(appId, target) {
        const message = readString(target, 'message');
        let sessionId = readOptionalString(target, 'sessionId');
        let registerGroup;
        if (!sessionId) {
            const conversationId = readString(target, 'conversationId');
            const ensured = await this.deps.sessions.ensureSession({
                appId,
                conversationId,
                title: readOptionalString(target, 'title'),
            });
            sessionId = ensured.session.sessionId;
            registerGroup = ensured.registerGroup;
        }
        const accepted = await this.deps.sessions.acceptMessage({
            appId,
            sessionId,
            message,
            senderId: readOptionalString(target, 'senderId') ?? 'external-ingress',
            senderName: readOptionalString(target, 'senderName') ?? 'External Ingress',
            threadId: readOptionalString(target, 'threadId') ?? undefined,
            correlationId: readOptionalString(target, 'correlationId') ?? null,
            responseMode: target.responseMode,
            webhookId: readOptionalString(target, 'webhookId'),
            beforeDurableAdmission: registerGroup
                ? () => this.deps.registerSessionGroup?.(registerGroup)
                : undefined,
        });
        return {
            targetKind: 'session_message',
            sessionId,
            messageId: accepted.messageId,
            acceptedEventId: accepted.acceptedEventId,
            wait: {
                kind: 'session',
                sessionId,
                afterEventId: accepted.acceptedEventId,
            },
            ...(registerGroup ? { registerGroup } : {}),
            enqueue: toPublicSessionQueueIntent(accepted.enqueue),
            [EXTERNAL_INGRESS_RUNTIME_DISPATCH]: {
                enqueue: accepted.enqueue,
                localEnqueue: !accepted.enqueue.durableAdmissionCreated,
            },
        };
    }
    async invokeConversationMessage(appId, invocationId, target) {
        if (!this.deps.conversationMessages) {
            throw new ApplicationError('UNAVAILABLE', 'Conversation message ingress is unavailable');
        }
        const conversationId = readString(target, 'conversationId');
        const message = readString(target, 'message');
        const senderName = readOptionalString(target, 'senderName');
        const messageRef = readOptionalString(target, 'messageRef');
        const accepted = await this.deps.conversationMessages.acceptMessage({
            appId,
            invocationId,
            conversationId,
            threadId: readOptionalString(target, 'threadId'),
            agentId: readOptionalString(target, 'agentId'),
            message,
            senderId: readOptionalString(target, 'senderId'),
            senderName,
            ...(messageRef ? { messageRef } : {}),
            correlationId: readOptionalString(target, 'correlationId'),
        });
        if (this.deps.conversationProviderMessages)
            await this.deps.conversationProviderMessages.send({
                conversationJid: accepted.enqueue.conversationJid,
                threadId: accepted.enqueue.threadId,
                providerAccountId: accepted.enqueue.providerAccountId,
                text: formatConversationMessageProjection({ message, senderName }),
            });
        return {
            targetKind: 'conversation_message',
            conversationId: accepted.conversationId,
            threadId: accepted.threadId,
            messageId: accepted.messageId,
            acceptedEventId: accepted.acceptedEventId,
            [EXTERNAL_INGRESS_RUNTIME_DISPATCH]: {
                enqueue: accepted.enqueue,
                localEnqueue: !accepted.enqueue.durableAdmissionCreated,
            },
        };
    }
    async invokeJobTrigger(appId, target) {
        const jobId = readString(target, 'jobId');
        const trigger = await this.deps.jobs.triggerJob({
            appId,
            jobId,
            consumeRateLimit: this.deps.consumeTriggerRateLimit,
            perAppLimit: this.deps.perAppTriggerLimit,
            perJobLimit: this.deps.perJobTriggerLimit,
        });
        return {
            targetKind: 'job_trigger',
            jobId,
            triggerId: trigger.triggerId,
            wait: { kind: 'trigger', triggerId: trigger.triggerId },
        };
    }
    async invokeJobTemplate(appId, metadata, target) {
        const templateId = readString(target, 'templateId');
        const template = readTemplate(metadata, templateId);
        const variables = readVariables(target.variables);
        const allowed = new Set(template.allowedVariables ?? []);
        for (const key of Object.keys(variables)) {
            if (!allowed.has(key)) {
                throw new ApplicationError('FORBIDDEN', `Variable is not allowed by job template: ${key}`);
            }
        }
        const prompt = renderTemplate(template.prompt, variables);
        const created = await this.deps.jobs.createJob({
            appId,
            name: template.name,
            prompt,
            sessionId: template.sessionId,
            kind: 'once',
            runAt: this.deps.now(),
        });
        const trigger = await this.deps.jobs.triggerJob({
            appId,
            jobId: created.jobId,
            consumeRateLimit: this.deps.consumeTriggerRateLimit,
            perAppLimit: this.deps.perAppTriggerLimit,
            perJobLimit: this.deps.perJobTriggerLimit,
        });
        return {
            targetKind: 'job_template',
            templateId,
            jobId: created.jobId,
            triggerId: trigger.triggerId,
            wait: { kind: 'trigger', triggerId: trigger.triggerId },
        };
    }
    async markInvocationFailed(invocationId, error) {
        try {
            await this.deps.control.updateExternalIngressInvocation({
                invocationId,
                status: 'failed',
                error: error instanceof Error ? error.message : 'Invocation failed',
                now: this.deps.now(),
            });
        }
        catch {
            // Dispatch errors should stay visible to the caller even if the
            // best-effort failure status update races with shutdown or deletion.
        }
    }
}
function formatConversationMessageProjection(input) {
    const senderName = input.senderName?.trim() || 'External System';
    return `${senderName}: ${input.message.trim()}`;
}
function publicIngress(ingress) {
    return {
        ingressId: ingress.ingressId,
        appId: ingress.appId,
        name: ingress.name,
        enabled: ingress.enabled,
        metadata: ingress.metadata,
        createdAt: ingress.createdAt,
        updatedAt: ingress.updatedAt,
    };
}
function parseBody(rawBody) {
    try {
        const parsed = rawBody.trim() ? JSON.parse(rawBody) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // Caller receives the typed invalid-body error below.
    }
    throw new ApplicationError('INVALID_REQUEST', 'Invalid JSON body');
}
function readTarget(body) {
    const target = body.target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new ApplicationError('INVALID_REQUEST', 'target is required');
    }
    const kind = target.kind;
    if (typeof kind !== 'string' || !kind.trim()) {
        throw new ApplicationError('INVALID_REQUEST', 'target.kind is required');
    }
    return target;
}
function addDaysIso(value, days) {
    const time = Date.parse(value);
    const base = Number.isFinite(time) ? time : currentTimeMs();
    return new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
}
function assertSameIdempotencyBody(invocation, bodyHash) {
    if (invocation.bodyHash !== bodyHash) {
        throw new ApplicationError('CONFLICT', 'Idempotency key reused with different request body');
    }
}
function duplicateInvocationResponse(invocation) {
    const response = invocation.response &&
        typeof invocation.response === 'object' &&
        !Array.isArray(invocation.response)
        ? invocation.response
        : {};
    return {
        invocationId: invocation.invocationId,
        duplicate: true,
        status: invocation.status,
        ...response,
        ...(invocation.error ? { error: invocation.error } : {}),
    };
}
