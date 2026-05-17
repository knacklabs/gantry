import path from 'node:path';

import {
  hasBashShellControlSyntax,
  validateReadableAgentToolRule,
} from './agent-tool-references.js';
import {
  isValidSemanticCapabilityId,
  parseSemanticCapabilityRule,
  semanticCapabilityIdValidationReason,
  semanticCapabilityRule,
} from './semantic-capability-ids.js';
import { NEUTRAL_CA_TRUST_ENV_KEYS } from './neutral-ca-trust-env.js';

export type SemanticCapabilityRisk = 'read' | 'write' | 'admin';
export type SemanticCapabilityCredentialSource =
  | 'onecli'
  | 'external_broker'
  | 'configured_access'
  | 'local_cli'
  | 'none';
export type SemanticCapabilityImplementationKind =
  | 'tool_rule'
  | 'mcp_tool'
  | 'adapter'
  | 'local_cli';

export interface SemanticCapabilityImplementationBinding {
  kind: SemanticCapabilityImplementationKind;
  rule?: string;
  mcpTool?: string;
  adapterRef?: string;
  executablePath?: string;
  executableVersion?: string;
  executableHash?: string;
  commandTemplates?: string[];
  authPreflightCommand?: string;
  deniedEnvPatterns?: string[];
}

export interface SemanticCapabilityDefinition {
  capabilityId: string;
  displayName: string;
  category: string;
  risk: SemanticCapabilityRisk;
  accountLabel?: string;
  can: string;
  cannot: string;
  credentialSource: SemanticCapabilityCredentialSource;
  implementationBindings: SemanticCapabilityImplementationBinding[];
  preflight?: {
    kind: 'none' | 'command' | 'broker';
    command?: string;
    status?: 'unknown' | 'healthy' | 'expired' | 'missing';
    message?: string;
  };
  protectedPaths?: string[];
  redactionPolicy?: {
    fields?: string[];
    env?: string[];
    commandParts?: string[];
  };
  sandboxProfile?: {
    network?: 'none' | 'required';
    filesystem?: 'read_only' | 'workspace_write' | 'credential_read';
  };
}

const SEMANTIC_CAPABILITY_SCHEMA_FORMAT = 'myclaw.semantic-capability.v1';

export const DEFAULT_LOCAL_CLI_DENIED_ENV_PATTERNS = [
  '*TOKEN*',
  '*SECRET*',
  '*PASSWORD*',
  '*API_KEY*',
  '*CREDENTIAL*',
  '*CONFIG*',
  '*PROXY*',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  ...NEUTRAL_CA_TRUST_ENV_KEYS,
] as const;

const NEUTRAL_CA_TRUST_ENV_KEY_SET = new Set<string>(NEUTRAL_CA_TRUST_ENV_KEYS);

const BUILTIN_SEMANTIC_CAPABILITIES = [
  {
    capabilityId: 'google.sheets.read',
    displayName: 'Google Sheets read',
    category: 'Google Sheets',
    risk: 'read',
    accountLabel: 'Configured Google access',
    can: 'Read spreadsheet metadata and cell values through configured Google access.',
    cannot:
      'Edit spreadsheets, change sharing, access Gmail, or receive raw OAuth tokens.',
    credentialSource: 'configured_access',
    implementationBindings: [
      { kind: 'adapter', adapterRef: 'configured.google.sheets.read' },
    ],
    preflight: { kind: 'none' },
    sandboxProfile: { network: 'required', filesystem: 'read_only' },
  },
  {
    capabilityId: 'google.sheets.write',
    displayName: 'Google Sheets write',
    category: 'Google Sheets',
    risk: 'write',
    accountLabel: 'Configured Google access',
    can: 'Read and update spreadsheet values through configured Google access.',
    cannot:
      'Change sharing, manage Drive files outside Sheets operations, access Gmail, or receive raw OAuth tokens.',
    credentialSource: 'configured_access',
    implementationBindings: [
      { kind: 'adapter', adapterRef: 'configured.google.sheets.write' },
    ],
    preflight: { kind: 'none' },
    sandboxProfile: { network: 'required', filesystem: 'read_only' },
  },
  {
    capabilityId: 'gmail.read',
    displayName: 'Gmail read',
    category: 'Gmail',
    risk: 'read',
    accountLabel: 'Configured Google access',
    can: 'Search and read Gmail message metadata and bodies through configured Google access.',
    cannot:
      'Send mail, delete mail, change labels, access Sheets, or receive raw OAuth tokens.',
    credentialSource: 'configured_access',
    implementationBindings: [
      { kind: 'adapter', adapterRef: 'configured.gmail.read' },
    ],
    preflight: { kind: 'none' },
    sandboxProfile: { network: 'required', filesystem: 'read_only' },
  },
] as const satisfies readonly SemanticCapabilityDefinition[];

export function listBuiltinSemanticCapabilities(): SemanticCapabilityDefinition[] {
  return BUILTIN_SEMANTIC_CAPABILITIES.map(cloneCapabilityDefinition);
}

export function getBuiltinSemanticCapability(
  capabilityId: string,
): SemanticCapabilityDefinition | undefined {
  const found = BUILTIN_SEMANTIC_CAPABILITIES.find(
    (capability) => capability.capabilityId === capabilityId,
  );
  return found ? cloneCapabilityDefinition(found) : undefined;
}

export function semanticCapabilityInputSchema(
  capability: SemanticCapabilityDefinition,
) {
  return {
    format: SEMANTIC_CAPABILITY_SCHEMA_FORMAT,
    schema: cloneCapabilityDefinition(capability),
  };
}

export function semanticCapabilityFromToolCatalogItem(input: {
  name?: string;
  inputSchema?: unknown;
}): SemanticCapabilityDefinition | undefined {
  const capabilityId = input.name
    ? parseSemanticCapabilityRule(input.name)
    : undefined;
  const schemaCapability = parseSemanticCapabilitySchema(input.inputSchema);
  if (schemaCapability) return schemaCapability;
  return capabilityId ? getBuiltinSemanticCapability(capabilityId) : undefined;
}

export function semanticCapabilityRuntimeRules(
  capability: SemanticCapabilityDefinition,
): string[] {
  const rules = capability.implementationBindings.flatMap((binding) => {
    if (binding.rule) return [binding.rule.trim()];
    if (binding.mcpTool) return [binding.mcpTool.trim()];
    if (binding.kind === 'local_cli') {
      return [];
    }
    return [];
  });
  return [...new Set(rules.filter(Boolean))];
}

export function projectToolCatalogItemToRuntimeRules(input: {
  name: string;
  inputSchema?: unknown;
}): string[] {
  const capability = semanticCapabilityFromToolCatalogItem(input);
  if (!capability) return [input.name];
  return [
    semanticCapabilityRule(capability.capabilityId),
    ...semanticCapabilityRuntimeRules(capability),
  ];
}

export function validateSemanticCapabilityDefinition(
  capability: SemanticCapabilityDefinition,
): { ok: true } | { ok: false; reason: string } {
  const idReason = semanticCapabilityIdValidationReason(
    capability.capabilityId,
  );
  if (idReason) return { ok: false, reason: idReason };
  if (!capability.displayName.trim()) {
    return { ok: false, reason: 'Capability displayName is required.' };
  }
  if (!capability.category.trim()) {
    return { ok: false, reason: 'Capability category is required.' };
  }
  if (!capability.can.trim() || !capability.cannot.trim()) {
    return {
      ok: false,
      reason: 'Capability must describe what it can and cannot do.',
    };
  }
  if (capability.implementationBindings.length === 0) {
    return {
      ok: false,
      reason: 'Capability must include at least one implementation binding.',
    };
  }
  for (const binding of capability.implementationBindings) {
    const validation = validateSemanticCapabilityBinding(binding);
    if (!validation.ok) return validation;
  }
  for (const protectedPath of capability.protectedPaths ?? []) {
    const trimmedPath = protectedPath.trim();
    if (!trimmedPath) {
      return { ok: false, reason: 'Protected paths cannot be empty.' };
    }
    if (!path.isAbsolute(trimmedPath) && !trimmedPath.startsWith('~/')) {
      return {
        ok: false,
        reason:
          'Protected paths must be absolute paths or home-relative paths.',
      };
    }
  }
  return { ok: true };
}

export function buildLocalCliSemanticCapability(input: {
  capabilityId: string;
  displayName: string;
  category: string;
  risk: SemanticCapabilityRisk;
  accountLabel?: string;
  can: string;
  cannot: string;
  executablePath: string;
  executableVersion?: string;
  executableHash?: string;
  commandTemplates: string[];
  authPreflightCommand?: string;
  protectedPaths?: string[];
  deniedEnvPatterns?: string[];
}): SemanticCapabilityDefinition {
  return {
    capabilityId: input.capabilityId.trim(),
    displayName: input.displayName.trim(),
    category: input.category.trim(),
    risk: input.risk,
    accountLabel: input.accountLabel?.trim() || undefined,
    can: input.can.trim(),
    cannot: input.cannot.trim(),
    credentialSource: 'local_cli',
    implementationBindings: [
      {
        kind: 'local_cli',
        executablePath: input.executablePath.trim(),
        executableVersion: input.executableVersion?.trim() || undefined,
        executableHash: input.executableHash?.trim() || undefined,
        commandTemplates: input.commandTemplates.map((item) => item.trim()),
        authPreflightCommand: input.authPreflightCommand?.trim() || undefined,
        deniedEnvPatterns: [
          ...new Set([
            ...DEFAULT_LOCAL_CLI_DENIED_ENV_PATTERNS,
            ...(input.deniedEnvPatterns ?? []),
          ]),
        ],
      },
    ],
    preflight: input.authPreflightCommand
      ? { kind: 'command', command: input.authPreflightCommand.trim() }
      : { kind: 'command', status: 'unknown' },
    protectedPaths: input.protectedPaths,
    sandboxProfile: { network: 'required', filesystem: 'credential_read' },
    redactionPolicy: {
      env: [...DEFAULT_LOCAL_CLI_DENIED_ENV_PATTERNS],
      commandParts: ['token', 'secret', 'password'],
    },
  };
}

export function capabilityDisplayNameForRule(rule: string): string | undefined {
  const capabilityId = parseSemanticCapabilityRule(rule);
  if (!capabilityId) return undefined;
  return getBuiltinSemanticCapability(capabilityId)?.displayName;
}

function validateSemanticCapabilityBinding(
  binding: SemanticCapabilityImplementationBinding,
): { ok: true } | { ok: false; reason: string } {
  if (binding.rule) {
    const validation = validateReadableAgentToolRule(binding.rule);
    if (!validation.ok) return validation;
  }
  if (binding.mcpTool) {
    const validation = validateReadableAgentToolRule(binding.mcpTool);
    if (!validation.ok) return validation;
  }
  if (binding.kind !== 'local_cli') return { ok: true };
  return validateLocalCliBinding(binding);
}

function validateLocalCliBinding(
  binding: SemanticCapabilityImplementationBinding,
): { ok: true } | { ok: false; reason: string } {
  const executablePath = binding.executablePath?.trim() ?? '';
  if (!path.isAbsolute(executablePath)) {
    return {
      ok: false,
      reason: 'Local CLI capabilities require an absolute executable path.',
    };
  }
  if (!binding.executableVersion?.trim()) {
    return {
      ok: false,
      reason: 'Local CLI capabilities require an executable version.',
    };
  }
  if (!binding.executableHash?.trim()) {
    return {
      ok: false,
      reason: 'Local CLI capabilities require an executable hash.',
    };
  }
  const templates = binding.commandTemplates ?? [];
  if (templates.length === 0) {
    return {
      ok: false,
      reason: 'Local CLI capabilities require allowed command templates.',
    };
  }
  for (const commandTemplate of templates) {
    const validation = validateLocalCliCommandTemplate(
      executablePath,
      commandTemplate,
    );
    if (!validation.ok) return validation;
  }
  if (binding.authPreflightCommand) {
    const validation = validateLocalCliCommandTemplate(
      executablePath,
      binding.authPreflightCommand,
      { allowWildcard: false },
    );
    if (!validation.ok) return validation;
  }
  return { ok: true };
}

function validateLocalCliCommandTemplate(
  executablePath: string,
  commandTemplate: string,
  options: { allowWildcard?: boolean } = { allowWildcard: true },
): { ok: true } | { ok: false; reason: string } {
  const trimmed = commandTemplate.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Local CLI command template cannot be empty.' };
  }
  if (hasBashShellControlSyntax(trimmed)) {
    return {
      ok: false,
      reason:
        'Local CLI command templates cannot contain shell control syntax.',
    };
  }
  if (hasShellRedirectionSyntax(trimmed)) {
    return {
      ok: false,
      reason:
        'Local CLI command templates cannot contain shell redirection syntax.',
    };
  }
  if (!trimmed.startsWith(`${executablePath} `)) {
    return {
      ok: false,
      reason:
        'Local CLI command templates must start with the pinned executable path.',
    };
  }
  if (containsDeniedEnvAssignment(trimmed)) {
    return {
      ok: false,
      reason:
        'Local CLI command templates cannot override token, credential, proxy, config, or CA environment keys.',
    };
  }
  const args = trimmed.slice(executablePath.length).trim().split(/\s+/);
  if (args.length === 0 || args[0] === '*') {
    return {
      ok: false,
      reason:
        'Local CLI command templates must scope a concrete subcommand, not the whole executable.',
    };
  }
  if (options.allowWildcard === false && trimmed.includes('*')) {
    return {
      ok: false,
      reason: 'Local CLI preflight commands cannot contain wildcards.',
    };
  }
  const readableRule = `Bash(${trimmed})`;
  const ruleValidation = validateReadableAgentToolRule(readableRule);
  if (!ruleValidation.ok) return ruleValidation;
  return { ok: true };
}

function hasShellRedirectionSyntax(value: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = quote !== "'";
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '<' || ch === '>') return true;
  }
  return false;
}

function containsDeniedEnvAssignment(command: string): boolean {
  return command.split(/\s+/).some((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0) return false;
    const key = part.slice(0, eq).toUpperCase();
    return (
      key.includes('TOKEN') ||
      key.includes('SECRET') ||
      key.includes('PASSWORD') ||
      key.includes('API_KEY') ||
      key.includes('CREDENTIAL') ||
      key.includes('CONFIG') ||
      key.includes('PROXY') ||
      NEUTRAL_CA_TRUST_ENV_KEY_SET.has(key)
    );
  });
}

function parseSemanticCapabilitySchema(
  inputSchema: unknown,
): SemanticCapabilityDefinition | undefined {
  if (!inputSchema || typeof inputSchema !== 'object') return undefined;
  const record = inputSchema as Record<string, unknown>;
  if (record.format !== SEMANTIC_CAPABILITY_SCHEMA_FORMAT) return undefined;
  const schema = record.schema;
  if (!schema || typeof schema !== 'object') return undefined;
  const capability = schema as SemanticCapabilityDefinition;
  if (!isValidSemanticCapabilityId(capability.capabilityId ?? '')) {
    return undefined;
  }
  const validation = validateSemanticCapabilityDefinition(capability);
  return validation.ok ? cloneCapabilityDefinition(capability) : undefined;
}

function cloneCapabilityDefinition(
  capability: SemanticCapabilityDefinition,
): SemanticCapabilityDefinition {
  return JSON.parse(JSON.stringify(capability)) as SemanticCapabilityDefinition;
}
