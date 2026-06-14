import fs from 'fs';
import path from 'path';

import type { AgentInput } from './agent-spawn-types.js';
import type { EgressGatewayPrivateHostMapping } from './egress-gateway.js';
import { projectSandboxRuntimeModelGatewayEnv } from './agent-spawn-runtime-policy.js';
import {
  deepAgentsShellToolEnabled,
  type DeepAgentsShellFilesystemGuardInput,
} from './deepagents-shell-filesystem-guard.js';

const SANDBOX_RUNTIME_GO_DNS = 'netdns=go';

// Host env projection for the DeepAgents shell tool. Returns the enable flag the
// runner reads when (and only when) the run is a DeepAgents run that requests
// shell (RunCommand) authority AND is confined by an enforcing sandbox — derived
// from the SAME guard inputs as the pre-spawn admission check so host and runner
// agree. The pre-spawn guard already fails the spawn closed for shell authority
// without an enforcing sandbox, so this only flips to '1' on the allowed path.
export function deepAgentsShellEnabledEnv(
  input: DeepAgentsShellFilesystemGuardInput,
): Record<string, string> {
  return deepAgentsShellToolEnabled(input)
    ? { GANTRY_DEEPAGENTS_SHELL_ENABLED: '1' }
    : {};
}

export type RunnerAgentInput = Omit<AgentInput, 'toolPolicyRules'> & {
  allowedTools?: string[];
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
