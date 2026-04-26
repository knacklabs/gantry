import fs from 'fs';
import path from 'path';

import {
  AGENTS_DIR,
  DATA_DIR,
  getCredentialBrokerRuntimeConfig,
  getHostCredentialEnv,
} from '../config/index.js';
import { resolveExternalCredentialBaseUrl } from '../config/credentials/broker-url-policy.js';
import { getAgentCredentialInjection } from '../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../adapters/credentials/agent-credential-broker-factory.js';
import { createExternalAgentCredentialInjection } from '../adapters/llm/external-credential-injection.js';
import { RegisteredGroup } from '../domain/types.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type { CredentialBrokerProfile } from '../domain/models/credentials.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../platform/group-folder.js';
import {
  ensureGroupIpcLayout,
  getHostAgentRunnerDistDir,
  ensureSharedSessionSettings,
  syncGroupSkills,
} from './agent-spawn-layout.js';
import { HostRuntimeContext } from './agent-spawn-types.js';

export async function getHostRuntimeCredentialEnv(
  agentIdentifier?: string,
  broker?: AgentCredentialBroker,
): Promise<{
  env: Record<string, string>;
  brokerApplied: boolean;
  brokerProfile: CredentialBrokerProfile;
}> {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  const injection =
    brokerConfig.mode === 'external'
      ? await getAgentCredentialInjection({
          mode: 'external',
          agentIdentifier,
          externalInjection: createExternalAgentCredentialInjection({
            normalizedBaseUrl: resolveExternalCredentialBaseUrl(
              brokerConfig.externalBrokerBaseUrl,
            ),
            hostCredentialEnv: getHostCredentialEnv(),
          }),
        })
      : brokerConfig.mode === 'onecli'
        ? await getAgentCredentialInjection({
            mode: 'onecli',
            agentIdentifier,
            broker: await resolveOnecliBroker(broker, brokerConfig.onecliUrl),
          })
        : await getAgentCredentialInjection({
            mode: 'none',
            agentIdentifier,
          });

  return {
    env: injection.env,
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

  // Shared .claude/ under runtime home for skills, settings, plugins.
  ensureSharedSessionSettings();
  syncGroupSkills();
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
