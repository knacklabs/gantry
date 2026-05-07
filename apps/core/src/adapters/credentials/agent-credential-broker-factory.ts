import {
  ensureAgentCredentialBinding as ensureApplicationAgentCredentialBinding,
  ensureModelCredentialBinding as ensureApplicationModelCredentialBinding,
} from '../../application/credentials/agent-credential-service.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { CredentialBrokerProfile } from '../../domain/models/credentials.js';
import { OnecliAgentCredentialBroker } from './onecli/broker.js';

export interface AgentCredentialBrokerFactoryOptions {
  mode: CredentialBrokerProfile;
  broker?: AgentCredentialBroker;
  onecliUrl?: string;
  dataDir?: string;
}

export async function createAgentCredentialBroker(
  options: AgentCredentialBrokerFactoryOptions,
): Promise<AgentCredentialBroker | undefined> {
  if (options.broker) return options.broker;
  if (options.mode !== 'onecli') return undefined;
  if (!options.dataDir) {
    throw new Error(
      'OneCLI credential broker creation requires an adapter-owned data directory.',
    );
  }
  return new OnecliAgentCredentialBroker({
    onecliUrl: options.onecliUrl,
    dataDir: options.dataDir,
  });
}

export async function ensureModelCredentialBinding(input: {
  mode: CredentialBrokerProfile;
  onecliUrl?: string;
  dataDir?: string;
  broker?: AgentCredentialBroker;
}): Promise<{ created?: boolean } | undefined> {
  const broker = await createAgentCredentialBroker({
    mode: input.mode,
    broker: input.broker,
    onecliUrl: input.onecliUrl,
    dataDir: input.dataDir,
  });
  return ensureApplicationModelCredentialBinding({
    mode: input.mode,
    broker,
  });
}

export async function ensureAgentCredentialBinding(input: {
  mode: CredentialBrokerProfile;
  onecliUrl?: string;
  dataDir?: string;
  broker?: AgentCredentialBroker;
  name: string;
  identifier: string;
}): Promise<{ created?: boolean } | undefined> {
  const broker = await createAgentCredentialBroker({
    mode: input.mode,
    broker: input.broker,
    onecliUrl: input.onecliUrl,
    dataDir: input.dataDir,
  });
  return ensureApplicationAgentCredentialBinding({
    mode: input.mode,
    broker,
    name: input.name,
    identifier: input.identifier,
  });
}
