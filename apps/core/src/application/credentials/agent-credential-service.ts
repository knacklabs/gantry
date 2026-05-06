import type {
  AgentCredentialPurpose,
  AgentCredentialInjection,
  CredentialBrokerProfile,
} from '../../domain/models/credentials.js';
import {
  MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
  MODEL_RUNTIME_CREDENTIAL_NAME,
} from '../../domain/models/credentials.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import { isCredentialBrokerBoundaryError } from '../../domain/models/credential-errors.js';

export type AgentCredentialInjectionInput =
  | {
      mode: 'external';
      purpose?: AgentCredentialPurpose;
      agentIdentifier?: string;
      externalInjection: AgentCredentialInjection;
    }
  | {
      mode: 'onecli';
      purpose?: AgentCredentialPurpose;
      agentIdentifier?: string;
      broker: AgentCredentialBroker;
    }
  | {
      mode: 'none';
      purpose?: AgentCredentialPurpose;
      agentIdentifier?: string;
    };

export async function getAgentCredentialInjection(
  input: AgentCredentialInjectionInput,
): Promise<AgentCredentialInjection> {
  if (input.mode === 'external') {
    if (!input.externalInjection) {
      throw new Error(
        'External credential mode is enabled but no external credential injection was provided.',
      );
    }
    return input.externalInjection;
  }

  if (input.mode === 'none') {
    return {
      env: {},
      applied: false,
      brokerProfile: 'none',
    };
  }

  const broker = input.broker;
  if (!broker) {
    throw new Error(
      'Credential broker mode is enabled but no agent credential broker was provided.',
    );
  }

  try {
    const purpose = input.purpose ?? 'model_runtime';
    return await broker.getInjection({
      binding: {
        profile: input.mode,
        purpose,
        ...(purpose === 'tool_capability'
          ? { agentIdentifier: input.agentIdentifier }
          : {}),
      },
    });
  } catch (err) {
    if (isCredentialBrokerBoundaryError(err)) {
      throw err;
    }
    const suffix =
      (input.purpose ?? 'model_runtime') === 'model_runtime'
        ? ` for ${MODEL_RUNTIME_CREDENTIAL_NAME}`
        : input.agentIdentifier
          ? ` for agent ${input.agentIdentifier}`
          : '';
    throw new Error(
      `Credential broker mode is enabled but the credential broker is not reachable${suffix}.`,
      { cause: err },
    );
  }
}

export async function ensureModelCredentialBinding(input: {
  mode: CredentialBrokerProfile;
  broker?: AgentCredentialBroker;
}): Promise<{ created?: boolean } | undefined> {
  if (input.mode !== 'onecli') return undefined;
  const broker = input.broker;
  if (!broker) {
    throw new Error(
      'Credential broker mode is enabled but no agent credential broker was provided.',
    );
  }
  const bindable = broker as
    | (AgentCredentialBroker & {
        ensureAgent?: (agent: {
          name: string;
          identifier: string;
        }) => Promise<{ created?: boolean }>;
      })
    | undefined;
  return bindable?.ensureAgent?.({
    name: MODEL_RUNTIME_CREDENTIAL_NAME,
    identifier: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
  });
}
