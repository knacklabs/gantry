import fs from 'fs';
import path from 'path';

import {
  AGENTS_DIR,
  getCredentialBrokerRuntimeConfig,
} from '../config/index.js';
import { envConfig } from '../config/env/index.js';
import { getAgentCredentialInjection } from '../application/credentials/agent-credential-service.js';
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
  const injection = await getAgentCredentialInjection({
    mode: brokerConfig.mode,
    agentIdentifier,
    onecliUrl: brokerConfig.onecliUrl,
    externalBrokerUrl: brokerConfig.externalBrokerBaseUrl,
    broker,
    env: envConfig,
  });

  return {
    env: injection.env,
    brokerApplied: injection.applied,
    brokerProfile: injection.brokerProfile,
  };
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
