import { ApplicationError } from '../../../application/common/application-error.js';
export function parseLimit(raw) {
    if (!raw)
        return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 200)
        return undefined;
    return value;
}
export function externalRefFromContract(ref, fallbackKind) {
    if (!ref)
        return undefined;
    return {
        kind: fallbackKind,
        value: ref.id,
    };
}
function externalRefToContract(ref) {
    return ref ? { kind: ref.kind, id: ref.value } : undefined;
}
function memorySubjectToContract(subject) {
    if (!subject)
        return undefined;
    switch (subject.kind) {
        case 'app':
            return { type: 'app', id: subject.appId };
        case 'agent':
            return { type: 'agent', id: subject.agentId };
        case 'user':
            return { type: 'user', id: subject.userId };
        case 'conversation':
            return { type: 'conversation', id: subject.conversationId };
    }
}
function routeConfigToContract(subject) {
    if (!subject?.route)
        return undefined;
    return {
        ...(subject.route.trigger !== undefined
            ? { trigger: subject.route.trigger }
            : {}),
        ...(subject.route.requiresTrigger !== undefined
            ? { requiresTrigger: subject.route.requiresTrigger }
            : {}),
        ...(subject.route.agentConfig &&
            typeof subject.route.agentConfig === 'object' &&
            !Array.isArray(subject.route.agentConfig)
            ? { agentConfig: subject.route.agentConfig }
            : {}),
    };
}
export function memorySubjectFromContract(appId, raw, _conversationId) {
    if (!raw)
        return undefined;
    switch (raw.type) {
        case 'app':
            return { kind: 'app', appId };
        case 'agent':
            return { kind: 'agent', appId, agentId: raw.id };
        case 'user':
            return { kind: 'user', appId, userId: raw.id };
        case 'conversation':
            return {
                kind: 'conversation',
                appId,
                conversationId: raw.id,
            };
        default:
            throw new ApplicationError('INVALID_REQUEST', 'Unsupported memorySubject type for conversation install');
    }
}
export function providerToResponse(provider) {
    const placeholder = provider.capabilityFlags.includes('placeholder');
    return {
        id: provider.id,
        displayName: provider.displayName,
        capabilities: provider.capabilityFlags,
        runtimeSecretKeys: provider.allowedRuntimeSecretKeys ?? [],
        status: placeholder ? 'unavailable' : 'available',
        placeholder: placeholder || undefined,
        createdAt: provider.createdAt,
    };
}
export function providerAccountToResponse(providerAccount) {
    return {
        id: providerAccount.id,
        appId: providerAccount.appId,
        agentId: providerAccount.agentId,
        providerId: providerAccount.providerId,
        label: providerAccount.label,
        status: providerAccount.status,
        config: providerAccount.config,
        externalRef: externalRefToContract(providerAccount.externalIdentityRef),
        runtimeSecretRefs: providerAccount.runtimeSecretRefs,
        createdAt: providerAccount.createdAt,
        updatedAt: providerAccount.updatedAt,
    };
}
function conversationKindToContract(kind) {
    if (kind === 'direct')
        return 'dm';
    if (kind === 'service')
        return 'sdk';
    return kind;
}
function conversationStatusToContract(status) {
    return status === 'disabled' ? 'inactive' : status;
}
export function conversationToResponse(conversation) {
    return {
        id: conversation.id,
        appId: conversation.appId,
        providerAccountId: conversation.providerAccountId,
        externalRef: externalRefToContract(conversation.externalRef),
        kind: conversationKindToContract(conversation.kind),
        title: conversation.title ?? null,
        status: conversationStatusToContract(conversation.status),
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
    };
}
export function threadToResponse(thread) {
    return {
        id: thread.id,
        appId: thread.appId,
        conversationId: thread.conversationId,
        externalRef: externalRefToContract(thread.externalRef),
        title: thread.title ?? null,
        status: thread.status,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
    };
}
function messagePartToResponse(part, ordinal) {
    switch (part.kind) {
        case 'text':
            return { ordinal, kind: 'text', payload: { text: part.text } };
        case 'markdown':
            return {
                ordinal,
                kind: 'markdown',
                payload: { markdown: part.markdown },
            };
        case 'code':
            return {
                ordinal,
                kind: 'code',
                payload: { code: part.code, language: part.language },
            };
        case 'structured':
            return { ordinal, kind: 'structured', payload: part.value };
        case 'tool_result':
            return {
                ordinal,
                kind: 'tool_result',
                payload: { toolId: part.toolId, value: part.value },
            };
        case 'redacted':
            return { ordinal, kind: 'redacted', payload: { reason: part.reason } };
    }
}
export function messageToResponse(message) {
    return {
        id: message.id,
        appId: message.appId,
        conversationId: message.conversationId,
        threadId: message.threadId ?? null,
        externalMessageId: message.externalRef?.value ?? null,
        externalRef: externalRefToContract(message.externalRef),
        direction: message.direction,
        senderUserId: message.senderUserId ?? null,
        senderDisplayName: message.senderDisplayName ?? null,
        trust: message.trust,
        deliveryStatus: message.deliveryStatus ?? null,
        deliveredAt: message.deliveredAt ?? null,
        deliveryError: message.deliveryError ?? null,
        parts: message.parts.map(messagePartToResponse),
        attachments: message.attachments.map((attachment) => ({
            id: attachment.id,
            kind: attachment.kind,
            contentType: attachment.contentType ?? null,
            sizeBytes: attachment.sizeBytes ?? null,
            externalRef: externalRefToContract(attachment.externalRef),
            storageRef: attachment.storageRef ?? null,
            trust: attachment.trust,
        })),
        createdAt: message.createdAt,
        receivedAt: message.receivedAt ?? null,
    };
}
export function conversationInstallToResponse(install) {
    return {
        id: install.id,
        appId: install.appId,
        agentId: install.agentId,
        providerAccountId: install.providerAccountId,
        conversationId: install.conversationId,
        threadId: install.threadId ?? null,
        displayName: install.displayName,
        status: install.status,
        memoryScope: install.memoryScope,
        memorySubject: memorySubjectToContract(install.memorySubject),
        routeConfig: routeConfigToContract(install.memorySubject),
        workspaceSnapshotId: install.workspaceSnapshotId ?? null,
        permissionPolicyIds: install.permissionPolicyIds,
        createdAt: install.createdAt,
        updatedAt: install.updatedAt,
    };
}
export function conversationInstallPatchFromParsed(appId, conversationId, data) {
    return {
        ...(data.providerAccountId
            ? {
                providerAccountId: data.providerAccountId,
            }
            : {}),
        ...(data.threadId
            ? { threadId: data.threadId }
            : {}),
        ...(data.displayName ? { displayName: data.displayName } : {}),
        ...(data.memoryScope ? { memoryScope: data.memoryScope } : {}),
        ...(data.memorySubject
            ? {
                memorySubject: memorySubjectFromContract(appId, data.memorySubject, conversationId),
            }
            : {}),
        ...(data.routeConfig !== undefined
            ? { routeConfig: data.routeConfig }
            : {}),
        ...(data.workspaceSnapshotId !== undefined
            ? {
                workspaceSnapshotId: data.workspaceSnapshotId === null
                    ? null
                    : data.workspaceSnapshotId,
            }
            : {}),
        ...(data.permissionPolicyIds !== undefined
            ? {
                permissionPolicyIds: data.permissionPolicyIds,
            }
            : {}),
        ...(data.status ? { status: data.status } : {}),
    };
}
