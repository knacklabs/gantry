import { NEUTRAL_CA_TRUST_ENV_KEYS } from '../../../../shared/neutral-ca-trust-env.js';
import { skillActionCapabilityRuleForToolRule } from '../../../../shared/skill-action-capability-rules.js';
import { semanticCapabilityRule } from '../../../../shared/semantic-capability-ids.js';
import type { SemanticCapabilityDefinition } from '../../../../shared/semantic-capabilities.js';

export { NEUTRAL_CA_TRUST_ENV_KEYS };

type BashCommandKey = 'command' | 'cmd';

const GO_DNS_RESOLVER_ENV = 'GODEBUG=netdns=go';
const TOOL_NETWORK_COMMAND_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'FTP_PROXY',
  'ftp_proxy',
  'RSYNC_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'GRPC_PROXY',
  'grpc_proxy',
  'GIT_SSH_COMMAND',
  'NODE_USE_ENV_PROXY',
  'NO_PROXY',
  'no_proxy',
  ...NEUTRAL_CA_TRUST_ENV_KEYS,
] as const;

export function applyBashTrustEnv(
  toolName: string,
  input: Record<string, unknown>,
  toolNetworkEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  return applyBashTrustEnvWithProvenance(toolName, input, toolNetworkEnv)
    .toolInput;
}

export function normalizeReviewedScheduledSkillActionInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== 'Bash' && toolName !== 'RunCommand') return input;
  const commandKey = bashCommandKey(input);
  if (!commandKey) return input;
  const command = input[commandKey];
  if (typeof command !== 'string') return input;

  // Claude sometimes appends a redundant stderr-to-stdout merge to an exact
  // reviewed skill command. The runner already captures both streams, while
  // the extra shell token changes the durable approval hash. Canonicalize only
  // this no-op suffix and only after the caller proves the scheduled skill
  // action itself matched reviewed capability authority.
  const suffixStripped = command.replace(/\s+2>&1\s*$/, '');
  if (suffixStripped === command) return input;
  return { ...input, [commandKey]: suffixStripped.trimEnd() };
}

export function applyBashTrustEnvWithProvenance(
  toolName: string,
  input: Record<string, unknown>,
  toolNetworkEnv: Record<string, string | undefined>,
): {
  toolInput: Record<string, unknown>;
  hostInjectedCommandPrefix?: string;
} {
  if (toolName !== 'Bash' && toolName !== 'RunCommand') {
    return { toolInput: input };
  }
  const commandKey = bashCommandKey(input);
  if (!commandKey) return { toolInput: input };

  const command = input[commandKey];
  if (typeof command !== 'string' || !command.trim()) {
    return { toolInput: input };
  }

  const prefix = bashTrustEnvPrefix(toolNetworkEnv, command);
  const prefixedInput = command.startsWith(`${prefix} `)
    ? input
    : {
        ...input,
        [commandKey]: `${prefix} ${command}`,
      };
  // The runner process is already confined by Gantry's enforcing
  // sandbox_runtime boundary. Claude Code otherwise starts a second Linux
  // sandbox for Bash and its socat bridge cannot create AF_UNIX sockets after
  // the outer seccomp filter is active. Skip only that redundant inner layer;
  // direct-mode commands never receive this escape flag.
  const toolInput =
    process.env.GANTRY_SANDBOX_RUNTIME_PROXY === '1'
      ? { ...prefixedInput, dangerouslyDisableSandbox: true }
      : prefixedInput;

  return {
    toolInput,
    hostInjectedCommandPrefix: prefix,
  };
}

function bashCommandKey(input: Record<string, unknown>): BashCommandKey | null {
  if (typeof input.command === 'string') return 'command';
  if (typeof input.cmd === 'string') return 'cmd';
  return null;
}

function bashTrustEnvPrefix(
  toolNetworkEnv: Record<string, string | undefined>,
  command: string,
): string {
  const entries = [GO_DNS_RESOLVER_ENV];
  for (const key of TOOL_NETWORK_COMMAND_ENV_KEYS) {
    const value = toolNetworkEnv[key]?.trim();
    if (!value) continue;
    entries.push(`${key}=${shellSingleQuote(value)}`);
  }
  for (const key of reviewedSkillActionEnvKeys(command)) {
    const value = process.env[key]?.trim();
    if (!value) continue;
    entries.push(`${key}=${shellSingleQuote(value)}`);
  }
  return entries.join(' ');
}

function reviewedSkillActionEnvKeys(command: string): string[] {
  const definitions = readSkillActionDefinitions();
  const matchedRule = skillActionCapabilityRuleForToolRule(
    `RunCommand(${command.trim()})`,
    definitions,
  );
  if (!matchedRule) return [];
  const definition = definitions.find(
    (item) => semanticCapabilityRule(item.capabilityId) === matchedRule,
  );
  return [...new Set(definition?.redactionPolicy?.env ?? [])].sort();
}

function readSkillActionDefinitions(): SemanticCapabilityDefinition[] {
  const raw = process.env.GANTRY_SKILL_ACTIONS_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is SemanticCapabilityDefinition =>
            Boolean(item) && typeof item === 'object',
        )
      : [];
  } catch {
    return [];
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
