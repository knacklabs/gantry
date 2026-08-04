import type { HostCredentialMode } from '../config/credentials/mode.js';
import type { AgentHarness } from '../shared/agent-engine.js';
export type OnboardingStep = 'welcome' | 'runtime_home' | 'storage' | 'channel' | 'model' | 'memory' | 'credentials' | 'telegram' | 'slack' | 'config' | 'group' | 'verify' | 'ready';
export interface OnboardingData {
    runtimeHome: string;
    postgresSetupKind?: 'local' | 'hosted' | 'existing';
    postgresSchema?: string;
    primaryProvider?: 'telegram' | 'slack';
    telegramBotUsername?: string;
    telegramChatJid?: string;
    telegramDisplayName?: string;
    telegramAdminSenderId?: string;
    telegramAdminSenderName?: string;
    telegramPermissionApproverIds?: string;
    slackChatJid?: string;
    slackDisplayName?: string;
    slackPermissionApproverIds?: string;
    memoryEnabled?: boolean;
    embeddingsEnabled?: boolean;
    dreamingEnabled?: boolean;
    credentialMode?: HostCredentialMode;
    agentName?: string;
    selectedModel?: string;
    agentHarness?: AgentHarness;
    credentialLiveSkipProviderIds?: string[];
    workspaceKey?: string;
    conversationLabel?: string;
    maintenanceMode?: boolean;
    completedProviderSteps?: Array<'telegram' | 'slack'>;
    storedProviderSecretRefs?: Array<'telegram' | 'slack'>;
}
export interface OnboardingState {
    version: 1;
    status: 'in_progress' | 'completed';
    currentStep: OnboardingStep;
    updatedAt: string;
    data: OnboardingData;
}
export declare function createInitialState(runtimeHome: string): OnboardingState;
export declare function readOnboardingState(runtimeHome: string): OnboardingState | null;
export declare function writeOnboardingState(runtimeHome: string, state: OnboardingState): void;
export declare function clearOnboardingState(runtimeHome: string): void;
