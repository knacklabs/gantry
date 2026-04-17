import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  DATA_DIR,
  AGENTS_DIR,
  AGENT_ROOT,
  ONECLI_URL,
} from '../core/config.js';
import { resolveHostCredentialMode } from '../core/credential-mode.js';
import { readEnvFile } from '../core/env.js';
import { logger } from '../core/logger.js';
import { RegisteredGroup } from '../core/types.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../platform/group-folder.js';
import {
  ensureGroupIpcLayout,
  getHostAgentRunnerRoot,
  ensureSharedSessionSettings,
  syncGroupSkills,
} from './agent-spawn-layout.js';
import { HostRuntimeContext } from './agent-spawn-types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

const HOST_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
];

export async function getHostRuntimeCredentialEnv(
  agentIdentifier?: string,
): Promise<{
  env: Record<string, string>;
  onecliApplied: boolean;
  onecliCaPath?: string;
}> {
  const envFromFile = readEnvFile(HOST_AUTH_ENV_KEYS);
  const credentialModeRaw =
    process.env.MYCLAW_CREDENTIAL_MODE ||
    readEnvFile(['MYCLAW_CREDENTIAL_MODE']).MYCLAW_CREDENTIAL_MODE;
  const credentialMode = resolveHostCredentialMode(
    credentialModeRaw,
    ONECLI_URL,
  );
  const onecliUrl = ONECLI_URL?.trim();
  const onecliRequired = credentialMode === 'onecli-only';
  const onecliEnabled = credentialMode === 'hybrid' || onecliRequired;

  if (!onecliEnabled) {
    return {
      env: {
        ...envFromFile,
      },
      onecliApplied: false,
    };
  }
  if (!onecliUrl) {
    if (onecliRequired) {
      throw new Error(
        'OneCLI credential mode is enabled but ONECLI_URL is not configured.',
      );
    }
    return {
      env: {
        ...envFromFile,
      },
      onecliApplied: false,
    };
  }

  let onecliEnv: Record<string, string> = {};
  let onecliApplied = false;
  let onecliCaPath: string | undefined;

  try {
    const config = await onecli.getContainerConfig(agentIdentifier);
    onecliEnv = config.env;
    onecliApplied = true;
    if (config.caCertificate && config.caCertificateContainerPath) {
      try {
        fs.mkdirSync(path.dirname(config.caCertificateContainerPath), {
          recursive: true,
        });
        fs.writeFileSync(
          config.caCertificateContainerPath,
          config.caCertificate,
          {
            mode: 0o600,
          },
        );
        onecliCaPath = config.caCertificateContainerPath;
      } catch (err) {
        logger.warn(
          { certificatePath: config.caCertificateContainerPath, err },
          'Failed to write OneCLI CA certificate',
        );
      }
    }
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
    env: {
      ...(onecliRequired ? {} : envFromFile),
      ...onecliEnv,
    },
    onecliApplied,
    onecliCaPath,
  };
}

export function prepareHostRuntimeContext(
  group: RegisteredGroup,
): HostRuntimeContext {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Shared .claude/ under AGENT_ROOT for skills, settings, plugins
  ensureSharedSessionSettings();
  syncGroupSkills();
  const runnerRoot = getHostAgentRunnerRoot();

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
    runnerRoot,
  };
}
