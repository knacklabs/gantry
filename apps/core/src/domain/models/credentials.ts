import type { AppId } from '../app/app.js';
import type { AgentId } from '../agent/agent.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../conversation/conversation.js';
import type { AgentRunId } from '../events/events.js';
import type { JobId } from '../jobs/jobs.js';
import type { ModelCredentialProvider } from '../model-credentials/model-credentials.js';
import type { ModelRouteId } from '../../shared/model-catalog.js';

export type CredentialBrokerProfile = 'none' | 'gantry';
export type AgentCredentialProvider = 'native' | 'openrouter' | (string & {});
export type AgentCredentialPurpose = 'model_runtime' | 'tool_capability';

export const MODEL_RUNTIME_CREDENTIAL_IDENTIFIER = 'gantry-model-access';
export const MODEL_RUNTIME_CREDENTIAL_NAME = 'Gantry Model Access';

export interface AgentCredentialBrokerBinding {
  profile: CredentialBrokerProfile;
  purpose?: AgentCredentialPurpose;
  appId?: AppId;
  agentId?: AgentId;
  runId?: AgentRunId;
  jobId?: JobId;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  modelCredentialProviderId?: ModelCredentialProvider;
  modelRouteId?: ModelRouteId;
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
