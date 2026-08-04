import type { HostCredentialMode } from '../config/credentials/mode.js';
import { type AgentHarness } from '../shared/agent-engine.js';
import type { OnboardingState, OnboardingStep } from './onboarding-state.js';
export declare const FULL_SEQUENCE: OnboardingStep[];
export interface SetupDraft {
    runtimeHome: string;
    postgresSetupKind: 'local' | 'hosted' | 'existing';
    postgresDatabaseUrl: string;
    postgresSchema: string;
    primaryProvider: 'telegram' | 'slack';
    credentialMode: HostCredentialMode;
    agentName: string;
    selectedModel: string;
    agentHarness: AgentHarness;
    credentialLiveSkipProviderIds: string[];
    telegramBotToken: string;
    telegramChatJid: string;
    telegramDisplayName: string;
    telegramAdminSenderId: string;
    telegramAdminSenderName: string;
    telegramPermissionApproverIds: string;
    telegramBotUsername: string;
    slackBotToken: string;
    slackAppToken: string;
    slackChatJid: string;
    slackDisplayName: string;
    slackPermissionApproverIds: string;
    memoryEnabled: boolean;
    embeddingsEnabled: boolean;
    dreamingEnabled: boolean;
    workspaceKey: string;
    conversationLabel: string;
    startAfterSetup: boolean;
    maintenanceMode: boolean;
    hasConfiguredChannelBinding: boolean;
    hasStoredTelegramSecretRefs: boolean;
    hasStoredSlackSecretRefs: boolean;
}
export interface SetupFlowOptions {
    importMetaUrl: string;
    runtimeHome: string;
    initialStep?: OnboardingStep;
    title?: string;
}
export interface SetupFlowResult {
    status: 'completed' | 'resumed' | 'cancelled';
    runtimeHome: string;
    startAfterSetup: boolean;
}
export declare function defaultStepIndex(step: OnboardingStep | undefined): number;
export declare function shouldSkipStep(step: OnboardingStep, draft: SetupDraft): boolean;
export declare function shouldAutoSkipAnsweredProviderStep(step: OnboardingStep, draft: SetupDraft, state: OnboardingState | null): boolean;
export declare function updateStateData(state: OnboardingState, draft: SetupDraft): void;
export declare function updateDraftFromState(draft: SetupDraft, state: OnboardingState): void;
export declare function persistProgress(state: OnboardingState, runtimeHome: string): void;
export declare function restoreDraft(runtimeHome: string, state: OnboardingState | null): SetupDraft;
