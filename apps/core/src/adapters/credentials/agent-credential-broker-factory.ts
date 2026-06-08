import {
  ensureAgentCredentialBinding as ensureApplicationAgentCredentialBinding,
  ensureModelCredentialBinding as ensureApplicationModelCredentialBinding,
} from '../../application/credentials/agent-credential-service.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { ModelCredentialRepository } from '../../domain/ports/repositories.js';
import type { CredentialBrokerProfile } from '../../domain/models/credentials.js';
import { GantryModelGatewayBroker } from '../llm/anthropic-claude-agent/gantry-model-gateway.js';

export interface AgentCredentialBrokerFactoryOptions {
  mode: CredentialBrokerProfile;
  broker?: AgentCredentialBroker;
  modelCredentials?: ModelCredentialRepository;
  gatewayBindHost?: string;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
}

export async function createAgentCredentialBroker(
  options: AgentCredentialBrokerFactoryOptions,
): Promise<AgentCredentialBroker | undefined> {
  if (options.broker) return options.broker;
  if (options.mode !== 'gantry') return undefined;
  if (!options.modelCredentials) {
    throw new Error(
      'Gantry Model Gateway requires a model credential repository.',
    );
  }
  return new GantryModelGatewayBroker(options.modelCredentials, {
    bindHost: options.gatewayBindHost,
    audit: options.publishRuntimeEvent,
  });
}

export async function ensureModelCredentialBinding(input: {
  mode: CredentialBrokerProfile;
  broker?: AgentCredentialBroker;
  modelCredentials?: ModelCredentialRepository;
  gatewayBindHost?: string;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
}): Promise<{ created?: boolean } | undefined> {
  const broker = await createAgentCredentialBroker({
    mode: input.mode,
    broker: input.broker,
    modelCredentials: input.modelCredentials,
    gatewayBindHost: input.gatewayBindHost,
    publishRuntimeEvent: input.publishRuntimeEvent,
  });
  return ensureApplicationModelCredentialBinding({
    mode: input.mode,
    broker,
  });
}

export async function ensureAgentCredentialBinding(input: {
  mode: CredentialBrokerProfile;
  broker?: AgentCredentialBroker;
  modelCredentials?: ModelCredentialRepository;
  gatewayBindHost?: string;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
  name: string;
  identifier: string;
}): Promise<{ created?: boolean } | undefined> {
  const broker = await createAgentCredentialBroker({
    mode: input.mode,
    broker: input.broker,
    modelCredentials: input.modelCredentials,
    gatewayBindHost: input.gatewayBindHost,
    publishRuntimeEvent: input.publishRuntimeEvent,
  });
  return ensureApplicationAgentCredentialBinding({
    mode: input.mode,
    broker,
    name: input.name,
    identifier: input.identifier,
  });
}
