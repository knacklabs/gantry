import type { HostCredentialMode } from '../config/credentials/mode.js';
import type { AgentHarness } from '../shared/agent-engine.js';
import '../channels/register-builtins.js';
export interface OnboardingConfigInput {
    runtimeHome: string;
    postgresDatabaseUrl?: string;
    postgresSchema?: string;
    primaryProvider: 'telegram' | 'slack';
    telegramBotToken?: string;
    hasStoredTelegramSecretRefs?: boolean;
    telegramPermissionApproverIds?: string;
    slackBotToken?: string;
    slackAppToken?: string;
    hasStoredSlackSecretRefs?: boolean;
    slackPermissionApproverIds?: string;
    modelAlias?: string;
    agentHarness?: AgentHarness;
    credentialMode: HostCredentialMode;
    agentName?: string;
    memoryEnabled: boolean;
    embeddingsEnabled: boolean;
    dreamingEnabled: boolean;
}
export declare function persistOnboardingConfig(input: OnboardingConfigInput): Promise<void>;
export declare function prepareOnboardingCredentialStorage(input: {
    runtimeHome: string;
    postgresDatabaseUrl?: string;
    postgresSchema?: string;
}): Promise<void>;
