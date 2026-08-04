export declare const IPC_INTERACTION_RETENTION_TTL_MS: number;
export type IpcRequestClaimProbe = (requestPath: string) => boolean;
export declare function hasIpcRequestClaimMarker(requestPath: string, probe?: IpcRequestClaimProbe): boolean;
export declare function ipcInteractionAuthEnvelopeOptions(unbounded: boolean): {
    separateAuthExpiry: true;
    authLifetimeMs?: number;
    authPurpose?: 'unbounded-interaction';
};
export declare function ipcInteractionAuthValidationOptions(permissionLane: unknown): {
    extendedAuthPurpose: 'unbounded-interaction';
    extendedMaxAgeMs: number;
} | undefined;
export declare function ipcInteractionUnclaimableReason(kind: 'permission' | 'question'): string;
export declare function ipcQuestionWaitExpiredReason(permissionLane: unknown): string;
