import type {
  AgentCredentialPurpose,
  AgentCredentialBrokerBinding,
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

function brokerBindingFor(input: {
  mode: CredentialBrokerProfile;
  purpose?: AgentCredentialPurpose;
  agentIdentifier?: string;
}): AgentCredentialBrokerBinding {
  const purpose = input.purpose ?? 'model_runtime';
  return {
    profile: input.mode,
    purpose,
    ...(purpose === 'tool_capability'
      ? { agentIdentifier: input.agentIdentifier }
      : {}),
  };
}

function describeBrokerError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code || '')
      : '';
  return [code, message].filter(Boolean).join(': ') || 'unknown error';
}

function recoveryHintFor(mode: CredentialBrokerProfile): string {
  if (mode === 'onecli') {
    return [
      'Run `myclaw doctor` and `myclaw local doctor`.',
      "If you use MyClaw's provided local stack, start or recover OneCLI from the directory containing its shipped stack file, or pass that stack file explicitly.",
    ].join(' ');
  }
  if (mode === 'external') {
    return 'Run `myclaw doctor` and verify credential_broker.external.base_url points at a reachable broker endpoint.';
  }
  return 'Run `myclaw doctor` and configure credential_broker in settings.yaml if this agent needs brokered credentials.';
}

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
      binding: brokerBindingFor(input),
    });
  } catch (err) {
    if (isCredentialBrokerBoundaryError(err)) {
      throw err;
    }
    const purpose = input.purpose ?? 'model_runtime';
    const suffix =
      purpose === 'model_runtime'
        ? ` for ${MODEL_RUNTIME_CREDENTIAL_NAME}`
        : input.agentIdentifier
          ? ` for agent ${input.agentIdentifier}`
          : '';
    const health = await broker
      .healthCheck({ binding: brokerBindingFor(input) })
      .catch(() => undefined);
    const details = [
      `Reason: ${describeBrokerError(err)}.`,
      health && health.status !== 'pass'
        ? `Broker health: ${health.message}`
        : undefined,
      health?.nextAction ? `Next action: ${health.nextAction}` : undefined,
      `Recovery: ${recoveryHintFor(input.mode)}`,
    ].filter(Boolean);
    throw new Error(
      `Credential broker mode is enabled but the credential broker is not reachable${suffix}. ${details.join(' ')}`,
      { cause: err },
    );
  }
}

export async function ensureModelCredentialBinding(input: {
  mode: CredentialBrokerProfile;
  broker?: AgentCredentialBroker;
}): Promise<{ created?: boolean } | undefined> {
  return ensureAgentCredentialBinding({
    mode: input.mode,
    broker: input.broker,
    name: MODEL_RUNTIME_CREDENTIAL_NAME,
    identifier: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
  });
}

export async function ensureAgentCredentialBinding(input: {
  mode: CredentialBrokerProfile;
  broker?: AgentCredentialBroker;
  name: string;
  identifier: string;
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
    name: input.name,
    identifier: input.identifier,
  });
}
