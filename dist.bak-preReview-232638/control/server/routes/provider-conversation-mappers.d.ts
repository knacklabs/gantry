import type { AppId } from '../../../domain/app/app.js';
import type { ConversationInstall, ProviderAccount, ProviderAccountId, Provider } from '../../../domain/provider/provider.js';
import type { Conversation, ConversationId, ConversationThread, ConversationThreadId, UserId } from '../../../domain/conversation/conversation.js';
import type { MemorySubject } from '../../../domain/memory/memory.js';
import type { Message } from '../../../domain/messages/messages.js';
import type { PermissionPolicyId } from '../../../domain/permissions/permissions.js';
import type { WorkspaceSnapshotId } from '../../../domain/sandbox/sandbox.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { ExternalRef } from '../../../shared/ids/branded-id.js';
import type { ConversationInstallPatch } from '../../../application/provider-conversations/provider-conversation-control-use-cases.js';
export declare function parseLimit(raw: string | null): number | undefined;
export declare function externalRefFromContract<Kind extends string>(ref: {
    kind?: string;
    id: string;
} | undefined, fallbackKind: Kind): ExternalRef<Kind> | undefined;
export declare function memorySubjectFromContract(appId: AppId, raw: {
    type: string;
    id: string;
} | undefined, _conversationId?: ConversationId): MemorySubject | undefined;
export declare function providerToResponse(provider: Provider): {
    id: import("../../../domain/provider/provider.js").ProviderId;
    displayName: string;
    capabilities: string[];
    runtimeSecretKeys: string[];
    status: string;
    placeholder: true | undefined;
    createdAt: string;
};
export declare function providerAccountToResponse(providerAccount: ProviderAccount): {
    id: ProviderAccountId;
    appId: AppId;
    agentId: AgentId;
    providerId: import("../../../domain/provider/provider.js").ProviderId;
    label: string;
    status: "active" | "disabled";
    config: Record<string, unknown>;
    externalRef: {
        kind: string;
        id: string;
    } | undefined;
    runtimeSecretRefs: import("../../../domain/provider/provider.js").ProviderRuntimeSecretRefs;
    createdAt: string;
    updatedAt: string;
};
export declare function conversationToResponse(conversation: Conversation): {
    id: ConversationId;
    appId: AppId;
    providerAccountId: ProviderAccountId;
    externalRef: {
        kind: string;
        id: string;
    } | undefined;
    kind: string;
    title: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
};
export declare function threadToResponse(thread: ConversationThread): {
    id: ConversationThreadId;
    appId: AppId;
    conversationId: ConversationId;
    externalRef: {
        kind: string;
        id: string;
    } | undefined;
    title: string | null;
    status: "active" | "archived";
    createdAt: string;
    updatedAt: string;
};
export declare function messageToResponse(message: Message): {
    id: import("../../../domain/messages/messages.js").MessageId;
    appId: AppId;
    conversationId: ConversationId;
    threadId: ConversationThreadId | null;
    externalMessageId: string | null;
    externalRef: {
        kind: string;
        id: string;
    } | undefined;
    direction: import("../../../domain/messages/messages.js").MessageDirection;
    senderUserId: UserId | null;
    senderDisplayName: string | null;
    trust: import("../../../domain/messages/messages.js").MessageTrust;
    deliveryStatus: import("../../../domain/messages/messages.js").MessageDeliveryStatus | null;
    deliveredAt: string | null;
    deliveryError: string | null;
    parts: {
        ordinal: number;
        kind: string;
        payload: unknown;
    }[];
    attachments: {
        id: import("../../../shared/ids/branded-id.js").BrandedId<"MessageAttachmentId">;
        kind: "file" | "image" | "audio" | "video" | "other";
        contentType: string | null;
        sizeBytes: number | null;
        externalRef: {
            kind: string;
            id: string;
        } | undefined;
        storageRef: string | null;
        trust: import("../../../domain/messages/messages.js").MessageTrust;
    }[];
    createdAt: string;
    receivedAt: string | null;
};
export declare function conversationInstallToResponse(install: ConversationInstall): {
    id: import("../../../shared/ids/branded-id.js").BrandedId<"ConversationInstallId">;
    appId: AppId;
    agentId: AgentId;
    providerAccountId: ProviderAccountId;
    conversationId: ConversationId;
    threadId: ConversationThreadId | null;
    displayName: string;
    status: import("../../../domain/provider/provider.js").ConversationInstallStatus;
    memoryScope: import("../../../domain/provider/provider.js").ConversationInstallMemoryScope;
    memorySubject: {
        type: string;
        id: AppId;
    } | {
        type: string;
        id: AgentId;
    } | {
        type: string;
        id: UserId;
    } | {
        type: string;
        id: ConversationId;
    } | undefined;
    routeConfig: {
        agentConfig?: Record<string, unknown> | undefined;
        requiresTrigger?: boolean | undefined;
        trigger?: string | undefined;
    } | undefined;
    workspaceSnapshotId: WorkspaceSnapshotId | null;
    permissionPolicyIds: PermissionPolicyId[];
    createdAt: string;
    updatedAt: string;
};
export declare function conversationInstallPatchFromParsed(appId: AppId, conversationId: ConversationId, data: {
    providerAccountId?: string;
    threadId?: string;
    displayName?: string;
    memoryScope?: ConversationInstallPatch['memoryScope'];
    memorySubject?: {
        type: string;
        id: string;
    };
    routeConfig?: ConversationInstallPatch['routeConfig'];
    workspaceSnapshotId?: string | null;
    permissionPolicyIds?: string[];
    status?: ConversationInstallPatch['status'];
}): ConversationInstallPatch;
