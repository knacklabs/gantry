import path from 'node:path';

import {
  hasBashShellControlSyntax,
  isHostPrivateBrowserMcpServerName,
  RUN_COMMAND_TOOL_NAME,
  validateReadableAgentToolRule,
} from './agent-tool-references.js';
import { parseDeclaredNetworkHost } from './network-host-declaration.js';
import {
  isValidSemanticCapabilityId,
  parseSemanticCapabilityRule,
  semanticCapabilityIdValidationReason,
  semanticCapabilityRule,
} from './semantic-capability-ids.js';
import { NEUTRAL_CA_TRUST_ENV_KEYS } from './neutral-ca-trust-env.js';

export type SemanticCapabilityRisk = 'read' | 'write' | 'admin';
export type SemanticCapabilityCredentialSource =
  'configured_access' | 'skill_secret' | 'local_cli' | 'none';
export type SemanticCapabilityImplementationKind =
  | 'tool_rule'
  // Retained only so stored legacy definitions fail validation with a clear
  // cutover error instead of becoming untyped input.
  | 'mcp_tool'
  | 'mcp_pattern'
  | 'adapter'
  | 'local_cli';

export interface SemanticCapabilityImplementationBinding {
  kind: SemanticCapabilityImplementationKind;
  rule?: string;
  mcpTool?: string;
  // Reviewed MCP pattern binding: the third-party server name plus the
  // reviewed tool-name patterns (exact names or trailing-star globs such as
  // "list_*"). The pattern is the single action authority; source inventory
  // stays discovery-only.
  mcpServer?: string;
  mcpToolPatterns?: string[];
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
  version?: string;
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
  networkHosts?: string[];
  redactionPolicy?: {
    fields?: string[];
    env?: string[];
    commandParts?: string[];
  };
  sandboxProfile?: {
    network?: 'none' | 'required';
    filesystem?: 'read_only' | 'workspace_write' | 'credential_read';
  };
  source?: unknown;
}

const SEMANTIC_CAPABILITY_SCHEMA_FORMAT = 'gantry.semantic-capability.v1';
const LOCAL_CLI_MISSING_BINDING_REASON =
  'Local CLI capabilities require a local_cli implementation binding.';
const LOCAL_CLI_BINDING_SOURCE_REASON =
  'Local CLI bindings require credentialSource local_cli.';
const NETWORK_HOSTS_SOURCE_REASON =
  'networkHosts are only supported for local_cli or skill action capabilities.';
const LOCAL_CLI_PROTECTED_PATHS_REASON =
  'protectedPaths are only supported for local_cli capabilities.';

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

export function semanticCapabilityInputSchema(
  capability: SemanticCapabilityDefinition,
) {
  return {
    format: SEMANTIC_CAPABILITY_SCHEMA_FORMAT,
    schema: cloneCapabilityDefinition(capability),
  };
}

export function parseSemanticCapabilityDefinitionsRecord(
  raw: unknown,
): Record<string, SemanticCapabilityDefinition> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const definitions: Record<string, SemanticCapabilityDefinition> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const capability = value as SemanticCapabilityDefinition;
    if (capability.capabilityId !== key) continue;
    const validation = validateSemanticCapabilityDefinition(capability);
    if (!validation.ok) continue;
    definitions[key] = cloneCapabilityDefinition(capability);
  }
  return Object.keys(definitions).length > 0 ? definitions : undefined;
}

export function semanticCapabilityFromToolCatalogItem(input: {
  name?: string;
  inputSchema?: unknown;
}): SemanticCapabilityDefinition | undefined {
  const schemaCapability = parseSemanticCapabilitySchema(input.inputSchema);
  if (schemaCapability) return schemaCapability;
  return undefined;
}

export function semanticCapabilityRuntimeRules(
  capability: SemanticCapabilityDefinition,
): string[] {
  const rules = capability.implementationBindings.flatMap((binding) => {
    if (binding.kind === 'tool_rule' && binding.rule) {
      return [binding.rule.trim()];
    }
    if (binding.kind === 'mcp_pattern') {
      return mcpPatternBindingRuntimeRules(binding);
    }
    if (
      binding.kind === 'local_cli' &&
      capability.credentialSource === 'local_cli'
    ) {
      return (binding.commandTemplates ?? []).map(
        (template) => `${RUN_COMMAND_TOOL_NAME}(${template.trim()})`,
      );
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

export function expandSemanticCapabilityPermissionRules(input: {
  rules: readonly string[];
  definitions?: Record<string, SemanticCapabilityDefinition>;
}): string[] {
  const out = new Set<string>();
  for (const rule of input.rules) {
    const trimmed = rule.trim();
    if (!trimmed) continue;
    out.add(trimmed);
    const capabilityId = parseSemanticCapabilityRule(trimmed);
    if (!capabilityId) continue;
    const definition = input.definitions?.[capabilityId];
    if (!definition) continue;
    for (const runtimeRule of semanticCapabilityRuntimeRules(definition)) {
      if (runtimeRule.trim()) out.add(runtimeRule.trim());
    }
  }
  return [...out];
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
  const hasLocalCliBinding = capability.implementationBindings.some(
    (binding) => binding.kind === 'local_cli',
  );
  const hasNetworkHosts = (capability.networkHosts ?? []).some((host) =>
    host.trim(),
  );
  const isSkillAction = isSkillActionCapability(capability);
  if (capability.credentialSource === 'local_cli' && !hasLocalCliBinding) {
    return { ok: false, reason: LOCAL_CLI_MISSING_BINDING_REASON };
  }
  if (capability.credentialSource !== 'local_cli') {
    if (hasLocalCliBinding)
      return { ok: false, reason: LOCAL_CLI_BINDING_SOURCE_REASON };
    // Skill action capabilities (credentialSource skill_secret) may declare
    // networkHosts; validate proposals with the same parser as manifests.
    if (
      hasNetworkHosts &&
      (capability.credentialSource !== 'skill_secret' || !isSkillAction)
    ) {
      return { ok: false, reason: NETWORK_HOSTS_SOURCE_REASON };
    }
    if ((capability.protectedPaths ?? []).some((item) => item.trim())) {
      return { ok: false, reason: LOCAL_CLI_PROTECTED_PATHS_REASON };
    }
  }
  for (const host of capability.networkHosts ?? []) {
    const validation = parseDeclaredNetworkHost(host);
    if (!validation.ok) {
      return { ok: false, reason: `networkHosts ${validation.reason}` };
    }
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
    const validPathHint =
      path.isAbsolute(trimmedPath) ||
      /^(~|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)(?:[/\\]|$)/.test(
        trimmedPath,
      );
    if (!validPathHint) {
      return {
        ok: false,
        reason:
          'Protected paths must be absolute, home-relative, or env-rooted paths.',
      };
    }
  }
  return { ok: true };
}

function isSkillActionCapability(
  capability: SemanticCapabilityDefinition,
): boolean {
  const source = capability.source;
  return (
    Boolean(source) &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    (source as { kind?: unknown }).kind === 'skill_action'
  );
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
  networkHosts?: string[];
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
    networkHosts: input.networkHosts,
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
  return skillActionCapabilityDisplayName(capabilityId);
}

export function skillActionCapabilityDisplayName(
  capabilityId: string,
): string | undefined {
  const trimmed = capabilityId.trim();
  if (!trimmed.startsWith('skill.')) return undefined;
  const parts = trimmed.slice('skill.'.length).split('.');
  if (parts.length < 2) return undefined;
  const words = parts
    .slice(0, -1)
    .join('-')
    .split(/[-_.]+/g)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  if (words.length === 0) return undefined;
  return words.map(humanizeCapabilityWord).join(' ');
}

const MCP_PATTERN_SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const MCP_PATTERN_TOOL_PATTERN_RE = /^[A-Za-z0-9_.-]+\*?$/;

export function mcpPatternBindingRuntimeRules(
  binding: SemanticCapabilityImplementationBinding,
): string[] {
  if (binding.kind !== 'mcp_pattern') return [];
  const server = binding.mcpServer?.trim();
  if (!server) return [];
  return (binding.mcpToolPatterns ?? [])
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => `mcp__${server}__${pattern}`);
}

function validateMcpPatternBinding(
  binding: SemanticCapabilityImplementationBinding,
): { ok: true } | { ok: false; reason: string } {
  const server = binding.mcpServer?.trim() ?? '';
  if (!MCP_PATTERN_SERVER_NAME_RE.test(server)) {
    return {
      ok: false,
      reason: 'mcp_pattern bindings require a valid MCP server name.',
    };
  }
  if (server === 'gantry' || isHostPrivateBrowserMcpServerName(server)) {
    return {
      ok: false,
      reason: `mcp_pattern bindings cannot target the ${server} MCP server.`,
    };
  }
  const patterns = (binding.mcpToolPatterns ?? [])
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) {
    return {
      ok: false,
      reason:
        'mcp_pattern bindings require at least one reviewed tool pattern.',
    };
  }
  for (const pattern of patterns) {
    if (!MCP_PATTERN_TOOL_PATTERN_RE.test(pattern)) {
      return {
        ok: false,
        reason: `mcp_pattern tool patterns must be exact tool names or trailing-star globs: ${pattern}`,
      };
    }
  }
  return { ok: true };
}

function validateSemanticCapabilityBinding(
  binding: SemanticCapabilityImplementationBinding,
): { ok: true } | { ok: false; reason: string } {
  if (binding.kind === 'tool_rule' && !binding.rule?.trim()) {
    return { ok: false, reason: 'tool_rule bindings require a rule.' };
  }
  if (binding.kind === 'mcp_tool') {
    return {
      ok: false,
      reason:
        'mcp_tool bindings are no longer supported; use an exact mcp_pattern binding.',
    };
  }
  if (binding.kind === 'mcp_pattern') {
    const validation = validateMcpPatternBinding(binding);
    if (!validation.ok) return validation;
  }
  if (binding.kind === 'adapter' && !binding.adapterRef?.trim()) {
    return { ok: false, reason: 'adapter bindings require an adapterRef.' };
  }
  if (binding.rule) {
    const validation = validateReadableAgentToolRule(binding.rule);
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
  const readableRule = `${RUN_COMMAND_TOOL_NAME}(${trimmed})`;
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

function humanizeCapabilityWord(word: string, index: number): string {
  if (index > 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function cloneCapabilityDefinition(
  capability: SemanticCapabilityDefinition,
): SemanticCapabilityDefinition {
  return JSON.parse(JSON.stringify(capability)) as SemanticCapabilityDefinition;
}
