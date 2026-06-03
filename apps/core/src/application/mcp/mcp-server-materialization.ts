import type {
  MaterializedMcpServer,
  McpCredentialRef,
} from '../../domain/mcp/mcp-servers.js';
import { reviewedMcpToolPatterns } from '../../shared/mcp-tool-scope.js';
import { formatMissingGantrySecretsMessage } from '../../shared/user-visible-messages.js';
import { ApplicationError } from '../common/application-error.js';
import { STDIO_TEMPLATE_COMMANDS } from './mcp-server-policy.js';

export type SdkMcpServerConfig =
  | {
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> };

export interface MaterializedMcpCapability {
  name: string;
  config: SdkMcpServerConfig;
  allowedToolPatterns: string[];
  autoApproveToolPatterns: string[];
  allowedToolNames: string[];
  autoApproveToolNames: string[];
  networkHosts: string[];
  required: boolean;
}

export function materializeMcpRecord(
  record: MaterializedMcpServer,
  credentialEnv: Record<string, string>,
): MaterializedMcpCapability {
  const config = record.definition.config;
  const credentialValues = resolveCredentialValues(
    record.definition.credentialRefs,
    credentialEnv,
  );
  const definitionPatterns = reviewedMcpToolPatterns(record.definition);
  // Per-agent scope: when the binding declares its own allowed tool patterns,
  // the agent is restricted to that subset of the server definition. Empty means
  // the agent inherits the definition's full reviewed set.
  const bindingPatterns = record.binding.allowedToolPatterns ?? [];
  const allowedToolPatterns =
    bindingPatterns.length > 0 ? bindingPatterns : definitionPatterns;
  const allowedToolNames = allowedToolPatterns.map(
    (tool) => `mcp__${record.definition.name}__${tool}`,
  );
  const autoApproveToolNames = record.definition.autoApproveToolPatterns.map(
    (tool) => `mcp__${record.definition.name}__${tool}`,
  );
  if (config.transport === 'http' || config.transport === 'sse') {
    if (!config.url) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `${config.transport} MCP server requires url.`,
      );
    }
    const headers = {
      ...(config.headers ?? {}),
      ...credentialValues.headers,
    };
    return {
      name: record.definition.name,
      config: {
        type: config.transport,
        url: config.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      allowedToolPatterns,
      autoApproveToolPatterns: record.definition.autoApproveToolPatterns,
      allowedToolNames,
      autoApproveToolNames,
      networkHosts: record.definition.networkHosts ?? [],
      required: record.binding.required,
    };
  }

  const template = STDIO_TEMPLATE_COMMANDS[config.templateId ?? ''];
  if (!template) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Stored MCP stdio_template config references an unsupported templateId.',
    );
  }
  const env = {
    ...(config.env ?? {}),
    ...credentialValues.env,
  };
  return {
    name: record.definition.name,
    config: {
      type: 'stdio',
      command: template.command,
      args: [...template.args, ...(config.args ?? [])],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
    allowedToolPatterns,
    autoApproveToolPatterns: record.definition.autoApproveToolPatterns,
    allowedToolNames,
    autoApproveToolNames,
    networkHosts: record.definition.networkHosts ?? [],
    required: record.binding.required,
  };
}

function resolveCredentialValues(
  refs: McpCredentialRef[],
  credentialEnv: Record<string, string>,
): { env: Record<string, string>; headers: Record<string, string> } {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const ref of refs) {
    const value = credentialEnv[ref.name];
    if (!value) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        formatMissingGantrySecretsMessage([ref.name]),
      );
    }
    if (ref.target === 'env') env[ref.key] = value;
    else headers[ref.key] = value;
  }
  return { env, headers };
}
