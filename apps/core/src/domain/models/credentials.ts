export type CredentialBrokerProfile = 'none' | 'onecli' | 'external';
export type AgentCredentialProvider = 'native' | 'openrouter';
export type AgentCredentialPurpose = 'model_runtime' | 'tool_capability';

export const MODEL_RUNTIME_CREDENTIAL_IDENTIFIER = 'myclaw-model-access';
export const MODEL_RUNTIME_CREDENTIAL_NAME = 'MyClaw Model Access';

export interface AgentCredentialBrokerBinding {
  profile: CredentialBrokerProfile;
  purpose?: AgentCredentialPurpose;
  agentIdentifier?: string;
  agentName?: string;
}

export interface CredentialBrokerHealth {
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string[];
  nextAction?: string;
}

export interface AgentCredentialInjection {
  env: Record<string, string>;
  credentialProviders?: Partial<Record<string, AgentCredentialProvider>>;
  proxy?: {
    http?: string;
    https?: string;
  };
  certificates?: {
    nodeExtraCaCertsPath?: string;
  };
  applied: boolean;
  brokerProfile: CredentialBrokerProfile;
}
