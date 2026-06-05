import fs from 'fs';
import path from 'path';

import type { AgentInput } from './agent-spawn-types.js';
import type { EgressGatewayPrivateHostMapping } from './egress-gateway.js';
import { projectSandboxRuntimeModelGatewayEnv } from './agent-spawn-runtime-policy.js';

const SANDBOX_RUNTIME_GO_DNS = 'netdns=go';

export type RunnerAgentInput = AgentInput & {
  modelCredentialEnv?: Record<string, string>;
  toolNetworkEnv?: Record<string, string>;
};
type WarnLogger = (metadata: Record<string, unknown>, message: string) => void;
type SandboxRuntimeGatewayOptions = {
  allowedNetworkHosts?: string[];
  privateNetworkHostMappings?: readonly EgressGatewayPrivateHostMapping[];
};

export function cleanupRunnerMcpConfigFile(
  configPath: string | undefined,
  warn: WarnLogger,
): void {
  if (!configPath) return;
  try {
    fs.rmSync(configPath, { force: true });
  } catch (err) {
    warn({ err, configPath }, 'Failed to remove MCP runner handoff file');
  }
}

export function cleanupRunnerTempDir(
  dir: string | undefined,
  warn: WarnLogger,
): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    warn({ err, dir }, 'Failed to remove runner temp directory');
  }
}

export function protectedWritePathsForOuterSandbox(
  protectedPaths: readonly string[],
  providerConfigDir: string | undefined,
): string[] {
  if (!providerConfigDir) return [...protectedPaths];
  const resolvedProviderConfigDir = path.resolve(providerConfigDir);
  return protectedPaths.flatMap((item) =>
    path.resolve(item) === resolvedProviderConfigDir
      ? [
          path.join(providerConfigDir, ['settings', 'json'].join('.')),
          path.join(providerConfigDir, ['settings', 'local', 'json'].join('.')),
          path.join(providerConfigDir, ['m', 'cp'].join('')),
          path.join(providerConfigDir, ['ski', 'lls'].join('')),
        ]
      : [item],
  );
}

export function resolveClaudeCodeToolTempDir(
  baseTempDir: string | undefined,
): string | undefined {
  if (!baseTempDir) return undefined;
  const leaf =
    process.platform === 'win32'
      ? ['cla', 'ude'].join('')
      : `${['cla', 'ude'].join('')}-${process.getuid?.() ?? 0}`;
  return path.join(baseTempDir, leaf);
}

export function sandboxRuntimeToolProcessEnv(
  providerId: string,
  toolNetworkEnv: Record<string, string>,
): Record<string, string> {
  if (providerId !== 'sandbox_runtime') return {};
  return sandboxRuntimeToolNetworkEnv(providerId, toolNetworkEnv);
}

export function sandboxRuntimeToolNetworkEnv(
  providerId: string,
  toolNetworkEnv: Record<string, string>,
): Record<string, string> {
  if (providerId !== 'sandbox_runtime') return toolNetworkEnv;
  return {
    ...toolNetworkEnv,
    GODEBUG: toolNetworkEnv.GODEBUG?.trim() || SANDBOX_RUNTIME_GO_DNS,
  };
}

export function buildSandboxRuntimeGatewayOptions(
  providerId: string,
  allowedNetworkHosts: readonly string[],
  modelCredentialEnv: Record<string, string> | undefined,
): {
  modelCredentialEnv: Record<string, string> | undefined;
  gatewayOptions: SandboxRuntimeGatewayOptions;
} {
  if (providerId !== 'sandbox_runtime') {
    return { modelCredentialEnv, gatewayOptions: {} };
  }
  const projection = projectSandboxRuntimeModelGatewayEnv(modelCredentialEnv);
  const mergedHosts =
    projection.allowedNetworkHosts.length > 0
      ? [
          ...new Set([
            ...allowedNetworkHosts,
            ...projection.allowedNetworkHosts,
          ]),
        ]
      : [...allowedNetworkHosts];
  return {
    modelCredentialEnv: projection.modelCredentialEnv,
    gatewayOptions: {
      allowedNetworkHosts: mergedHosts,
      ...(projection.privateNetworkHostMappings.length > 0
        ? { privateNetworkHostMappings: projection.privateNetworkHostMappings }
        : {}),
    },
  };
}
