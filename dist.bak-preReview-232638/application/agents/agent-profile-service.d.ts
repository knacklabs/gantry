import { FileArtifactNotFoundError } from '../../domain/file-artifacts/file-artifact.js';
import type { FileArtifactStore } from '../../domain/ports/file-artifact-store.js';
import { type ProfileMirrorInput } from './prompt-profile-service.js';
export declare const PROFILE_FILE_KINDS: readonly ["soul", "agents"];
export type ProfileFileKind = (typeof PROFILE_FILE_KINDS)[number];
export declare const MAX_PROFILE_CONTENT_BYTES = 2000000;
export declare class ProfileContentTooLargeError extends Error {
    readonly maxBytes: number;
    constructor(maxBytes: number);
}
export declare function isProfileFileKind(value: unknown): value is ProfileFileKind;
export declare class ProfileVersionConflictError extends Error {
    readonly latestVersion: number;
    constructor(latestVersion: number);
}
export interface ProfileFileSummary {
    kind: ProfileFileKind;
    path: string;
    version: number;
    contentHash: string;
    sizeBytes: number;
    updatedAt: string | null;
}
export interface ProfileFileContent {
    kind: ProfileFileKind;
    path: string;
    version: number;
    contentHash: string;
    content: string;
}
export interface ProfileAuditInput {
    action: 'read' | 'update';
    agentFolder: string;
    kind: ProfileFileKind;
    version: number;
    contentHash: string;
    actor: string;
    approvalSource?: string;
}
export interface AgentProfileServiceOptions {
    fileArtifactStore: () => FileArtifactStore | undefined;
    appId?: string;
    mirrorProfileFile?: (input: ProfileMirrorInput) => void | Promise<void>;
    audit?: (input: ProfileAuditInput) => void | Promise<void>;
    onSideEffectError?: (input: {
        sideEffect: 'mirror' | 'audit';
        error: unknown;
        agentFolder: string;
        kind: ProfileFileKind;
        version: number;
    }) => void | Promise<void>;
}
export declare class AgentProfileService {
    private readonly fileArtifactStore;
    private readonly appId;
    private readonly mirrorProfileFile?;
    private readonly audit?;
    private readonly onSideEffectError?;
    constructor(options: AgentProfileServiceOptions);
    private requireStore;
    private latestDescriptor;
    listProfileFiles(agentFolder: string): Promise<ProfileFileSummary[]>;
    readProfileFile(agentFolder: string, kind: ProfileFileKind, options?: {
        actor?: string;
    }): Promise<ProfileFileContent>;
    writeProfileFile(input: {
        agentFolder: string;
        kind: ProfileFileKind;
        content: string;
        expectedVersion?: number;
        actor: string;
        approvalSource?: string;
        createdBy?: string;
    }): Promise<{
        version: number;
        contentHash: string;
    }>;
    private reportSideEffectError;
}
export { FileArtifactNotFoundError };
