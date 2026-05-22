import type { JobCapabilityRequirement } from '../../domain/types.js';
import { ApplicationError } from '../common/application-error.js';
import {
  isValidSemanticCapabilityId,
  semanticCapabilityRule,
} from '../../shared/semantic-capability-ids.js';
import { getBuiltinSemanticCapability } from '../../shared/semantic-capabilities.js';
import {
  RUN_COMMAND_TOOL_NAME,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import { isAbsoluteFilePath } from '../../shared/path-validation.js';

const IMPLEMENTATION_KINDS = new Set([
  'configured_access',
  'local_cli',
  'mcp_server',
  'builtin_tool',
]);

export function normalizeCapabilityRequirements(
  input: readonly JobCapabilityRequirement[] | undefined,
): JobCapabilityRequirement[] {
  if (!input || input.length === 0) return [];
  const out: JobCapabilityRequirement[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements entries must be objects.',
      );
    }
    const capabilityId = stringField(entry.capabilityId, 'capabilityId');
    if (!isValidSemanticCapabilityId(capabilityId)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements capabilityId must use lowercase dot-separated words such as google.sheets.write.',
      );
    }
    const reason = stringField(entry.reason, 'reason');
    const implementation = normalizeImplementation(entry.implementation);
    const key = `${capabilityId}\u0000${implementation?.kind ?? ''}\u0000${implementation?.name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      capabilityId,
      reason,
      ...(implementation ? { implementation } : {}),
    });
  }
  return out;
}

export function capabilityRequirementToolRules(
  requirements: readonly JobCapabilityRequirement[] | undefined,
): string[] {
  const normalized = normalizeCapabilityRequirements(requirements);
  return [
    ...new Set(
      normalized.map((item) => semanticCapabilityRule(item.capabilityId)),
    ),
  ];
}

export function formatCapabilityRequirement(
  requirement: JobCapabilityRequirement,
): string {
  const capability = humanizeCapabilityId(requirement.capabilityId);
  const implementation = requirement.implementation;
  if (!implementation?.name) return capability;
  return `${capability} using ${implementation.name}`;
}

export function capabilityRequirementSetupAction(
  requirement: JobCapabilityRequirement,
): string {
  const implementation = requirement.implementation;
  if (implementation?.kind === 'local_cli') {
    if (
      implementation.executablePath &&
      implementation.executableVersion &&
      implementation.executableHash &&
      implementation.commandTemplate
    ) {
      return [
        'propose_capability',
        JSON.stringify({
          capabilityId: requirement.capabilityId,
          displayName: formatCapabilityRequirement(requirement),
          category: 'Local CLI',
          risk: 'write',
          source: 'local_cli',
          credentialSource: 'local_cli',
          accountLabel: implementation.name,
          can: `Run reviewed ${implementation.name ?? 'local CLI'} command templates for this job.`,
          cannot:
            'Run commands outside the reviewed templates, receive raw tokens, or write credential stores.',
          executablePath: implementation.executablePath,
          executableVersion: implementation.executableVersion,
          executableHash: implementation.executableHash,
          commandTemplates: [implementation.commandTemplate],
          ...(implementation.authPreflight
            ? { authPreflightCommand: implementation.authPreflight }
            : {}),
          protectedPaths: implementation.protectedPaths ?? [],
          reason: requirement.reason,
        }),
      ].join(' ');
    }
    return [
      'scheduler_update_job',
      JSON.stringify({
        capabilityId: requirement.capabilityId,
        reason:
          'Fix local_cli implementation: executablePath must be absolute, executableVersion and executableHash must be pinned, and commandTemplate plus authPreflight must start with that exact executablePath.',
      }),
    ].join(' ');
  }
  return [
    'propose_capability',
    JSON.stringify({
      capabilityId: requirement.capabilityId,
      reason: requirement.reason,
    }),
  ].join(' ');
}

export function localCliCommandTemplatePermissionRule(
  commandTemplate: string | undefined,
  executablePath?: string | undefined,
): string | undefined {
  const normalized = normalizePlaceholderCommandTemplate(commandTemplate);
  if (!normalized) return undefined;
  const executableToken = normalized.split(/\s+/)[0];
  if (!isAbsoluteFilePath(executableToken)) return undefined;
  if (executablePath?.trim() && executableToken !== executablePath.trim()) {
    return undefined;
  }
  const validation = validateReadableAgentToolRule(
    `${RUN_COMMAND_TOOL_NAME}(${normalized})`,
  );
  return validation.ok ? normalized : undefined;
}

function normalizeImplementation(
  input: JobCapabilityRequirement['implementation'] | undefined,
): JobCapabilityRequirement['implementation'] | undefined {
  if (!input) return undefined;
  if (!IMPLEMENTATION_KINDS.has(input.kind)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'capabilityRequirements implementation.kind must be configured_access, local_cli, mcp_server, or builtin_tool.',
    );
  }
  const implementation: NonNullable<
    JobCapabilityRequirement['implementation']
  > = {
    kind: input.kind,
  };
  const name = optionalString(input.name);
  if (name) implementation.name = name;
  const executablePath = optionalString(input.executablePath);
  if (executablePath) implementation.executablePath = executablePath;
  const executableVersion = optionalString(input.executableVersion);
  if (executableVersion) implementation.executableVersion = executableVersion;
  const executableHash = optionalString(input.executableHash);
  if (executableHash) implementation.executableHash = executableHash;
  const commandTemplate = optionalString(input.commandTemplate);
  if (commandTemplate) implementation.commandTemplate = commandTemplate;
  const authPreflight = optionalString(input.authPreflight);
  if (authPreflight) implementation.authPreflight = authPreflight;
  if (input.kind === 'local_cli') {
    if (!implementation.executablePath) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements local_cli implementation.executablePath is required so the runtime does not rely on PATH resolution.',
      );
    }
    if (!isAbsoluteFilePath(implementation.executablePath)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements local_cli implementation.executablePath must be an absolute path.',
      );
    }
    if (!implementation.commandTemplate) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements local_cli implementation.commandTemplate is required so the runtime can propose reviewed local CLI access.',
      );
    }
    if (!implementation.executableVersion) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements local_cli implementation.executableVersion is required so reviewed access is pinned to a specific CLI build.',
      );
    }
    if (!implementation.executableHash) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements local_cli implementation.executableHash is required so reviewed access is pinned to a specific CLI executable.',
      );
    }
    const executableToken = implementation.commandTemplate.split(/\s+/)[0];
    if (executableToken !== implementation.executablePath) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements local_cli implementation.commandTemplate must start with the exact executablePath.',
      );
    }
    const authPreflightToken = implementation.authPreflight?.split(/\s+/)[0];
    if (
      authPreflightToken &&
      authPreflightToken !== implementation.executablePath
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'capabilityRequirements local_cli implementation.authPreflight must start with the exact executablePath.',
      );
    }
  }
  const protectedPaths = Array.isArray(input.protectedPaths)
    ? input.protectedPaths
        .map(optionalString)
        .filter((item): item is string => Boolean(item))
    : [];
  if (protectedPaths.length > 0) {
    implementation.protectedPaths = [...new Set(protectedPaths)];
  }
  return implementation;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `capabilityRequirements ${field} is required.`,
    );
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePlaceholderCommandTemplate(
  commandTemplate: string | undefined,
): string | undefined {
  const trimmed = commandTemplate?.trim();
  if (!trimmed) return undefined;
  const tokens = trimmed.split(/\s+/);
  const normalized: string[] = [];
  for (const token of tokens) {
    if (token === '*') {
      normalized.push('*');
      break;
    }
    if (token === '...' || /^<[^>]+>$/.test(token)) {
      normalized.push('*');
      break;
    }
    normalized.push(token);
  }
  return normalized.join(' ');
}

function humanizeCapabilityId(capabilityId: string): string {
  const builtin = getBuiltinSemanticCapability(capabilityId);
  if (builtin) return builtin.displayName;
  return capabilityId
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
