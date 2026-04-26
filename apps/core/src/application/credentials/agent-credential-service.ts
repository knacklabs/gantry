import type {
  AgentCredentialInjection,
  CredentialBrokerProfile,
} from '../../domain/models/credentials.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import { isCredentialBrokerBoundaryError } from '../../domain/models/credential-errors.js';

export type AgentCredentialInjectionInput =
  | {
      mode: 'external';
      agentIdentifier?: string;
      externalInjection: AgentCredentialInjection;
    }
  | {
      mode: 'onecli';
      agentIdentifier?: string;
      broker: AgentCredentialBroker;
    }
  | {
      mode: 'none';
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
    return await broker.getInjection({
      binding: {
        profile: input.mode,
        agentIdentifier: input.agentIdentifier,
      },
    });
  } catch (err) {
    if (isCredentialBrokerBoundaryError(err)) {
      throw err;
    }
    const suffix = input.agentIdentifier
      ? ` for agent ${input.agentIdentifier}`
      : '';
    throw new Error(
      `Credential broker mode is enabled but the credential broker is not reachable${suffix}.`,
      { cause: err },
    );
  }
}

export async function ensureAgentCredentialBinding(input: {
  mode: CredentialBrokerProfile;
  agentIdentifier: string;
  agentName: string;
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
    name: input.agentName,
    identifier: input.agentIdentifier,
  });
}
