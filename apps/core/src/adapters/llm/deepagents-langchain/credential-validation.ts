import type { AgentExecutionCredentialProjection } from '../../../application/agent-execution/agent-execution-adapter.js';
import type { ModelCatalogEntry } from '../../../shared/model-catalog.js';
import {
  agentEngineLabel,
  DEEPAGENTS_ENGINE,
} from '../../../shared/agent-engine.js';
import { getModelProviderDefinition } from '../../../shared/model-provider-registry.js';

// Credential-mode guard for the DeepAgents (LangChain) execution adapter. This
// adapter is selected ONLY for the `deepagents:langchain` execution provider, so
// the engine is definitively DeepAgents here. The deepagents execution routes
// declare supportedCredentialModes: ['api_key']; Claude OAuth/subscription is
// the Anthropic SDK lane only. The host threads the resolved bound credential
// mode through modelCredentialProjection.brokerAuthMode.
const DEEPAGENTS_OAUTH_CREDENTIAL_MESSAGE =
  'DeepAgents does not support Claude OAuth/subscription credentials in Gantry. Choose Anthropic SDK or configure Anthropic API-key Model Access.';

export function validateDeepAgentCredentialProjection(input: {
  entry?: ModelCatalogEntry;
  projection: AgentExecutionCredentialProjection;
}): void {
  const { entry, projection } = input;
  if (!entry) return;

  const provider = getModelProviderDefinition(entry.modelRoute.id);
  const supportedModes = provider?.executionRoutes.find(
    (route) => route.executionProviderId === 'deepagents:langchain',
  )?.supportedCredentialModes;

  if (projection.brokerProfile !== 'gantry') {
    throw new Error(
      `Setup required: configure ${provider?.label ?? entry.modelRoute.id} Model Access before using ${entry.recommendedAlias} with ${agentEngineLabel(DEEPAGENTS_ENGINE)}.`,
    );
  }

  // Claude OAuth/subscription is rejected for DeepAgents with the locked copy.
  if (projection.brokerAuthMode === 'claude_code_oauth') {
    throw new Error(DEEPAGENTS_OAUTH_CREDENTIAL_MESSAGE);
  }
  if (
    supportedModes &&
    projection.brokerAuthMode &&
    !supportedModes.includes(projection.brokerAuthMode)
  ) {
    throw new Error(DEEPAGENTS_OAUTH_CREDENTIAL_MESSAGE);
  }

  // Defense in depth: no raw provider OAuth/auth tokens may ride in the
  // projection env; only run-scoped gateway tokens (gtw_) are permitted.
  if (
    projection.env.CLAUDE_CODE_OAUTH_TOKEN ||
    projection.env.ANTHROPIC_AUTH_TOKEN
  ) {
    throw new Error(DEEPAGENTS_OAUTH_CREDENTIAL_MESSAGE);
  }
  assertGatewayToken(projection.env.OPENAI_API_KEY, entry);
  assertGatewayToken(projection.env.ANTHROPIC_API_KEY, entry);
}

function assertGatewayToken(
  value: string | undefined,
  entry: ModelCatalogEntry,
): void {
  if (value && !value.startsWith('gtw_')) {
    throw new Error(
      `Gantry Model Gateway projection for ${entry.displayName} must use a run-scoped gateway token.`,
    );
  }
}
