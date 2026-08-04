export declare function formatAvailableNowMessage(input: {
    action: string;
    noun: string;
    name: string;
    requiredEnvVars?: readonly string[];
}): string;
export declare function formatDeclaredGantrySecretLines(names: readonly string[], subject?: string): string[];
export declare function formatMissingGantrySecretsMessage(names: readonly string[]): string;
export declare function formatApprovalRequestedMessage(displayName: string): string;
export declare function formatNotApprovedMessage(input: {
    action: string;
    noun: string;
    name: string;
    reason?: string | null;
}): string;
export declare function humanizeTechnicalIdentifier(value: string | undefined): string;
