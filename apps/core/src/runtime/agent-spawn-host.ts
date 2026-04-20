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
  'MEMORY_EXTRACTOR_MAX_TURNS',
];
const ONECLI_ALLOWED_ENV_KEYS = new Set<string>([
  ...HOST_AUTH_ENV_KEYS,
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);
const ONECLI_CA_CERT_ROOT = path.resolve(DATA_DIR, 'onecli', 'certs');

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function safeRealpathSync(targetPath: string): string {
  const maybeRealpath = (
    fs as unknown as { realpathSync?: (p: string) => string }
  ).realpathSync;
  if (typeof maybeRealpath !== 'function') {
    return path.resolve(targetPath);
  }
  try {
    return maybeRealpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function resolvePathWithRealParent(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [path.basename(resolved)];
  let anchor = path.dirname(resolved);
  while (!fs.existsSync(anchor)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) break;
    suffix.unshift(path.basename(anchor));
    anchor = parent;
  }
  const realAnchor = safeRealpathSync(anchor);
  return path.join(realAnchor, ...suffix);
}

function sanitizeCertFileSegment(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return 'default';
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'default'
  );
}

function resolveOnecliCaTargetPath(
  requestedPath: string | undefined,
  agentIdentifier?: string,
): { targetPath: string; remapped: boolean } {
  const realRoot = safeRealpathSync(ONECLI_CA_CERT_ROOT);
  const fallbackPath = path.join(
    realRoot,
    `${sanitizeCertFileSegment(agentIdentifier)}.pem`,
  );
  if (!requestedPath) {
    return { targetPath: fallbackPath, remapped: false };
  }

  const resolvedRequestedPath = resolvePathWithRealParent(requestedPath);
  if (isPathInside(realRoot, resolvedRequestedPath)) {
    return { targetPath: resolvedRequestedPath, remapped: false };
  }

  return { targetPath: fallbackPath, remapped: true };
}

function filterOnecliEnv(
  source: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (
      !ONECLI_ALLOWED_ENV_KEYS.has(key) ||
      typeof value !== 'string' ||
      value.length === 0
    ) {
      dropped.push(key);
      continue;
    }
    out[key] = value;
  }
  if (dropped.length > 0) {
    logger.warn(
      {
        droppedKeys: dropped.sort().slice(0, 20),
        droppedCount: dropped.length,
      },
      'Dropped disallowed OneCLI env keys',
    );
  }
  return out;
}

function remapOnecliEnvCertificatePath(
  env: Record<string, string>,
  originalPath: string | undefined,
  targetPath: string,
): void {
  if (originalPath) {
    for (const [key, value] of Object.entries(env)) {
      if (value === originalPath) {
        env[key] = targetPath;
      }
    }
  }
  env.NODE_EXTRA_CA_CERTS = targetPath;
}

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
    onecliEnv = filterOnecliEnv(config.env || {});
    onecliApplied = true;
    if (config.caCertificate) {
      const requestedPath = config.caCertificateContainerPath?.trim();
      const { targetPath, remapped } = resolveOnecliCaTargetPath(
        requestedPath,
        agentIdentifier,
      );
      try {
        if (remapped && requestedPath) {
          logger.warn(
            {
              requestedPath,
              targetPath,
            },
            'Remapped OneCLI CA certificate path outside runtime data directory',
          );
        }
        fs.mkdirSync(path.dirname(targetPath), {
          recursive: true,
          mode: 0o700,
        });
        const realRoot = safeRealpathSync(ONECLI_CA_CERT_ROOT);
        const writeTargetPath = resolvePathWithRealParent(targetPath);
        if (!isPathInside(realRoot, writeTargetPath)) {
          throw new Error(
            `Refusing to write OneCLI CA certificate outside runtime root: ${writeTargetPath}`,
          );
        }
        fs.writeFileSync(writeTargetPath, config.caCertificate, {
          mode: 0o600,
        });
        remapOnecliEnvCertificatePath(
          onecliEnv,
          requestedPath,
          writeTargetPath,
        );
        onecliCaPath = writeTargetPath;
      } catch (err) {
        logger.warn(
          { certificatePath: targetPath, err },
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
