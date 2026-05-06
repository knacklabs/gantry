import fs from 'fs';
import path from 'path';

import {
  AGENTS_DIR,
  DATA_DIR,
  getCredentialBrokerRuntimeConfig,
} from '../config/index.js';
import { resolveExternalCredentialBaseUrl } from '../config/credentials/broker-url-policy.js';
import { getAgentCredentialInjection } from '../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../adapters/credentials/agent-credential-broker-factory.js';
import { createExternalAgentCredentialInjection } from '../adapters/llm/external-credential-injection.js';
import { RegisteredGroup } from '../domain/types.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type {
  AgentCredentialPurpose,
  AgentCredentialInjection,
  CredentialBrokerProfile,
} from '../domain/models/credentials.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../platform/group-folder.js';
import {
  ensureGroupIpcLayout,
  getHostAgentRunnerDistDir,
} from './agent-spawn-layout.js';
import { HostRuntimeContext } from './agent-spawn-types.js';

export interface HostRuntimeCredentialEnvOptions {
  purpose?: AgentCredentialPurpose;
}

export async function getHostRuntimeCredentialEnv(
  agentIdentifier?: string,
  broker?: AgentCredentialBroker,
  options: HostRuntimeCredentialEnvOptions = {},
): Promise<{
  env: Record<string, string>;
  credentialProviders: NonNullable<
    AgentCredentialInjection['credentialProviders']
  >;
  brokerApplied: boolean;
  brokerProfile: CredentialBrokerProfile;
}> {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  const purpose = options.purpose ?? 'model_runtime';
  const injection =
    brokerConfig.mode === 'external'
      ? await getAgentCredentialInjection({
          mode: 'external',
          purpose,
          agentIdentifier,
          externalInjection: createExternalAgentCredentialInjection({
            normalizedBaseUrl: resolveExternalCredentialBaseUrl(
              brokerConfig.externalBrokerBaseUrl,
            ),
          }),
        })
      : brokerConfig.mode === 'onecli'
        ? await getAgentCredentialInjection({
            mode: 'onecli',
            purpose,
            agentIdentifier,
            broker: await resolveOnecliBroker(broker, brokerConfig.onecliUrl),
          })
        : await getAgentCredentialInjection({
            mode: 'none',
            purpose,
            agentIdentifier,
          });

  return {
    env: injection.env,
    credentialProviders: injection.credentialProviders ?? {},
    brokerApplied: injection.applied,
    brokerProfile: injection.brokerProfile,
  };
}

async function resolveOnecliBroker(
  broker: AgentCredentialBroker | undefined,
  onecliUrl: string,
): Promise<AgentCredentialBroker> {
  const resolved =
    broker ??
    (await createAgentCredentialBroker({
      mode: 'onecli',
      onecliUrl,
      dataDir: DATA_DIR,
    }));
  if (!resolved) {
    throw new Error(
      'Credential broker mode is enabled but no agent credential broker was provided.',
    );
  }
  return resolved;
}

export function prepareHostRuntimeContext(
  group: RegisteredGroup,
): HostRuntimeContext {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const runnerDistDir = getHostAgentRunnerDistDir();

  const groupIpcDir = resolveGroupIpcPath(group.folder);
  ensureGroupIpcLayout(groupIpcDir);

  const sharedDirCandidate = path.join(AGENTS_DIR, 'shared');
  const globalDir = fs.existsSync(sharedDirCandidate)
    ? sharedDirCandidate
    : undefined;

  return {
    groupDir,
    globalDir,
    groupIpcDir,
    runnerDistDir,
  };
}
