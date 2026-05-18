import type {
  MaterializedMcpServer,
  McpCredentialRef,
} from '../../domain/mcp/mcp-servers.js';
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
  required: boolean;
}

export function materializeMcpRecord(
  record: MaterializedMcpServer,
  credentialEnv: Record<string, string>,
): MaterializedMcpCapability {
  const config = record.version.config;
  const credentialValues = resolveCredentialValues(
    record.version.credentialRefs,
    credentialEnv,
  );
  const allowedToolPatterns =
    record.version.allowedToolPatterns.length > 0
      ? record.version.allowedToolPatterns
      : record.version.autoApproveToolPatterns;
  const allowedToolNames = allowedToolPatterns.map(
    (tool) => `mcp__${record.definition.name}__${tool}`,
  );
  const autoApproveToolNames = record.version.autoApproveToolPatterns.map(
    (tool) => `mcp__${record.definition.name}__${tool}`,
  );
  if (config.transport === 'http' || config.transport === 'sse') {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Remote MCP HTTP/SSE servers cannot be projected directly to the SDK until runtime uses a DNS-pinned host transport.',
    );
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
    autoApproveToolPatterns: record.version.autoApproveToolPatterns,
    allowedToolNames,
    autoApproveToolNames,
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
