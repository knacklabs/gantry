export interface SetupReadyDraft {
    workspaceKey: string;
    agentName: string;
    agentHarness: string;
    conversationLabel: string;
    selectedModel: string;
    memoryEnabled?: boolean;
    embeddingsEnabled?: boolean;
    dreamingEnabled?: boolean;
}
export type ReadyStepAction = {
    type: 'next';
} | {
    type: 'start_now';
};
export declare function runReadyStep(draft: SetupReadyDraft): Promise<ReadyStepAction>;
