import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  AGENTS_DIR,
  DATA_DIR,
  MYCLAW_CREDENTIAL_MODE,
  ONECLI_URL,
} from '../config/index.js';
import { resolveHostCredentialMode } from '../config/credentials/mode.js';
import { logger } from '../infrastructure/logging/logger.js';
import { filterTrustedOnecliEnv } from '../infrastructure/onecli/env-policy.js';
import { assertValidOnecliUrl } from '../infrastructure/onecli/policy.js';
import { RegisteredGroup } from '../domain/types.js';
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

function filterOnecliEnv(
  source: Record<string, string>,
): Record<string, string> {
  const { env, droppedKeys } = filterTrustedOnecliEnv(source);
  if (droppedKeys.length > 0) {
    logger.warn(
      {
        droppedKeys: droppedKeys.sort().slice(0, 20),
        droppedCount: droppedKeys.length,
      },
      'Dropped disallowed OneCLI env keys',
    );
  }
  return env;
}

function applyOnecliCaCertificate(
  onecliEnv: Record<string, string>,
  caCertificate: string | undefined,
  agentIdentifier: string | undefined,
): void {
  if (!caCertificate) return;

  const caDir = path.join(DATA_DIR, 'onecli');
  const caPath = path.join(caDir, 'gateway-ca.pem');
  fs.mkdirSync(caDir, { recursive: true });
  fs.writeFileSync(caPath, caCertificate, { mode: 0o600 });
  onecliEnv.NODE_EXTRA_CA_CERTS = caPath;
  logger.info(
    { agentIdentifier: agentIdentifier || 'default', caPath },
    'Applied OneCLI CA certificate for host runner',
  );
}

export async function getHostRuntimeCredentialEnv(
  agentIdentifier?: string,
): Promise<{
  env: Record<string, string>;
  onecliApplied: boolean;
}> {
  const credentialModeRaw = MYCLAW_CREDENTIAL_MODE;
  const credentialMode = resolveHostCredentialMode(credentialModeRaw);
  const onecliUrl = ONECLI_URL?.trim();
  const onecliRequired = credentialMode === 'onecli';
  if (!onecliUrl) {
    if (onecliRequired) {
      throw new Error(
        'OneCLI credential mode is enabled but ONECLI_URL is not configured.',
      );
    }
    return {
      env: {},
      onecliApplied: false,
    };
  }
  const trustedOnecliUrl = assertValidOnecliUrl(onecliUrl);
  const onecli = new OneCLI({ url: trustedOnecliUrl });

  let onecliEnv: Record<string, string> = {};
  let onecliApplied = false;

  try {
    const config = await onecli.getContainerConfig(agentIdentifier);
    onecliEnv = filterOnecliEnv(config.env || {});
    applyOnecliCaCertificate(onecliEnv, config.caCertificate, agentIdentifier);
    onecliApplied = true;
  } catch (err) {
    logger.warn(
      { err, agentIdentifier: agentIdentifier || 'default' },
      'OneCLI gateway not reachable',
    );
    if (onecliRequired) {
      throw new Error(
        'OneCLI credential mode is enabled but the OneCLI gateway is not reachable.',
      );
    }
  }

  return {
    env: onecliEnv,
    onecliApplied,
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
