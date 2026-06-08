import type {
  AgentCredentialBrokerBinding,
  AgentCredentialInjection,
  CredentialBrokerHealth,
  CredentialBrokerProfile,
} from '../models/credentials.js';

export interface AgentCredentialBrokerInput {
  binding: AgentCredentialBrokerBinding;
}

export interface AgentCredentialBrokerCapabilities {
  profile: CredentialBrokerProfile;
  supportsAgentBinding: boolean;
  supportsModelRuntimeProfile?: boolean;
  modelRuntimeProfileIdentifier?: string;
  returnsRawSecrets: boolean;
  projectsProviderTokens?: boolean;
  projectedSecretEnvKeys?: string[];
}

export interface AgentCredentialBroker {
  getInjection(
    input: AgentCredentialBrokerInput,
  ): Promise<AgentCredentialInjection>;
  revokeInjection?(input: AgentCredentialBrokerInput): Promise<void>;
  close?(): Promise<void>;
  healthCheck(
    input?: AgentCredentialBrokerInput,
  ): Promise<CredentialBrokerHealth>;
  getCapabilities(): AgentCredentialBrokerCapabilities;
}
