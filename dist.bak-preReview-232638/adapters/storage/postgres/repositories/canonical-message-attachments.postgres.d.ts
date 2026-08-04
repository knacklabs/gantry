import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
type IncomingMessageAttachment = NonNullable<NewMessage['attachments']>[number];
export declare function attachmentsJsonForMessage(messageId: unknown): import("drizzle-orm").SQL<string | null>;
export declare function existingAttachmentStorageMaps(rows: Array<{
    id: string;
    externalRefJson: unknown;
    storageRef: string | null;
}>): {
    byId: Map<string, string>;
    byExternalId: Map<string, string>;
};
export declare function storageRefForIncomingAttachment(attachment: IncomingMessageAttachment, attachmentId: string, existingStorageRefs: ReturnType<typeof existingAttachmentStorageMaps>): string | null;
export {};
