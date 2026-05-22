import {
  RUN_COMMAND_TOOL_NAME,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import {
  normalizeBashLeafRuleContent,
  parseBashCommand,
} from '../../shared/bash-command-parser.js';
import {
  isValidSemanticCapabilityId,
  semanticCapabilityIdValidationReason,
} from '../../shared/semantic-capability-ids.js';
import type {
  SemanticCapabilityDefinition,
  SemanticCapabilityRisk,
} from '../../shared/semantic-capabilities.js';
import { validatePersistentRequestPermissionRule } from '../../shared/persistent-permission-rules.js';
import {
  assertValidCapabilitySecretName,
  normalizeCapabilitySecretName,
} from '../capability-secrets/capability-secrets.js';

export const SKILL_ACTION_MANIFEST_FILE = 'gantry.skill.json';

export interface SkillActionPermission {
  id: string;
  capabilityId: string;
  displayName: string;
  risk: SemanticCapabilityRisk;
  can: string;
  cannot: string;
  requiredEnvVars: string[];
  commandTemplates: string[];
}

export interface SkillActionSourceMetadata {
  kind: 'skill_action';
  skillId: string;
  skillName: string;
  skillVersion: string;
  skillContentHash: string;
  actionId: string;
}

export function sanitizeSkillDirectoryName(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return safe || 'skill';
}

export function parseSkillActionPermissionsFromAssets(input: {
  assets: Array<{ path: string; content: Uint8Array }>;
  skillName: string;
}): SkillActionPermission[] {
  const manifest = input.assets.find(
    (asset) => asset.path === SKILL_ACTION_MANIFEST_FILE,
  );
  if (!manifest) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(manifest.content).toString('utf-8'));
  } catch (error) {
    throw new Error(`${SKILL_ACTION_MANIFEST_FILE} must contain valid JSON.`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.actions)) {
    throw new Error(`${SKILL_ACTION_MANIFEST_FILE} requires an actions array.`);
  }
  if (parsed.actions.length > 20) {
    throw new Error(
      `${SKILL_ACTION_MANIFEST_FILE} supports at most 20 actions.`,
    );
  }
  const seenCapabilities = new Set<string>();
  return parsed.actions.map((entry, index) => {
    const action = parseSkillActionPermission(entry, {
      skillName: input.skillName,
      index,
    });
    if (seenCapabilities.has(action.capabilityId)) {
      throw new Error(
        `${SKILL_ACTION_MANIFEST_FILE} duplicates capabilityId ${action.capabilityId}.`,
      );
    }
    seenCapabilities.add(action.capabilityId);
    return action;
  });
}

export function skillActionSemanticCapability(input: {
  skillId: string;
  skillName: string;
  skillVersion: string;
  skillContentHash: string;
  action: SkillActionPermission;
}): SemanticCapabilityDefinition {
  const source: SkillActionSourceMetadata = {
    kind: 'skill_action',
    skillId: input.skillId,
    skillName: input.skillName,
    skillVersion: input.skillVersion,
    skillContentHash: input.skillContentHash,
    actionId: input.action.id,
  };
  return {
    capabilityId: input.action.capabilityId,
    displayName: input.action.displayName,
    category: input.skillName,
    risk: input.action.risk,
    can: input.action.can,
    cannot: input.action.cannot,
    credentialSource: 'skill_secret',
    implementationBindings: input.action.commandTemplates.map((template) => ({
      kind: 'tool_rule',
      rule: `${RUN_COMMAND_TOOL_NAME}(${template})`,
    })),
    preflight: { kind: 'none' },
    sandboxProfile: { network: 'required', filesystem: 'workspace_write' },
    redactionPolicy:
      input.action.requiredEnvVars.length > 0
        ? { env: input.action.requiredEnvVars }
        : undefined,
    source,
  };
}

export function skillActionSource(
  capability: SemanticCapabilityDefinition,
): SkillActionSourceMetadata | undefined {
  const source = capability.source;
  if (!isRecord(source) || source.kind !== 'skill_action') return undefined;
  const skillId = typeof source.skillId === 'string' ? source.skillId : '';
  const skillName =
    typeof source.skillName === 'string' ? source.skillName : '';
  const skillVersion =
    typeof source.skillVersion === 'string' ? source.skillVersion : '';
  const skillContentHash =
    typeof source.skillContentHash === 'string' ? source.skillContentHash : '';
  const actionId = typeof source.actionId === 'string' ? source.actionId : '';
  if (!skillId || !skillName || !skillVersion || !skillContentHash || !actionId)
    return undefined;
  return {
    kind: 'skill_action',
    skillId,
    skillName,
    skillVersion,
    skillContentHash,
    actionId,
  };
}

function parseSkillActionPermission(
  raw: unknown,
  context: { skillName: string; index: number },
): SkillActionPermission {
  if (!isRecord(raw)) {
    throw new Error(
      `Skill action at index ${context.index} must be an object.`,
    );
  }
  const id = stringField(raw, 'id');
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(id)) {
    throw new Error(
      `Skill action ${context.index} id must use lowercase letters, numbers, dashes, or underscores.`,
    );
  }
  const capabilityId = stringField(raw, 'capabilityId');
  if (
    !isValidSemanticCapabilityId(capabilityId) ||
    !capabilityId.startsWith('skill.')
  ) {
    throw new Error(
      semanticCapabilityIdValidationReason(capabilityId) ??
        'Skill action capabilityId must use the skill.<name>.<action> namespace.',
    );
  }
  const displayName = stringField(raw, 'displayName');
  const risk = raw.risk;
  if (risk !== 'read' && risk !== 'write' && risk !== 'admin') {
    throw new Error(
      `Skill action ${capabilityId} risk must be read, write, or admin.`,
    );
  }
  const can = stringField(raw, 'can');
  const cannot = stringField(raw, 'cannot');
  const commandTemplates = stringArray(
    raw.commandTemplates,
    'commandTemplates',
  ).map((template) =>
    normalizeSkillActionCommandTemplate(template, context.skillName),
  );
  if (commandTemplates.length === 0) {
    throw new Error(`Skill action ${capabilityId} requires commandTemplates.`);
  }
  const requiredEnvVars = stringArray(raw.requiredEnvVars, 'requiredEnvVars', {
    optional: true,
  }).map(normalizeCapabilitySecretName);
  for (const envVar of requiredEnvVars) assertValidCapabilitySecretName(envVar);
  return {
    id,
    capabilityId,
    displayName,
    risk,
    can,
    cannot,
    requiredEnvVars: [...new Set(requiredEnvVars)],
    commandTemplates: [...new Set(commandTemplates)],
  };
}

function normalizeSkillActionCommandTemplate(
  value: string,
  skillName: string,
): string {
  const skillDir = `skills/${sanitizeSkillDirectoryName(skillName)}`;
  const withSkillRoot = value.trim().replaceAll('${skillRoot}', skillDir);
  if (!withSkillRoot) {
    throw new Error('Skill action command template cannot be empty.');
  }
  if (hasEnvAssignmentToken(withSkillRoot)) {
    throw new Error(
      'Skill action command templates cannot include shell environment assignments.',
    );
  }
  if (hasSecretLikeCommandPart(withSkillRoot)) {
    throw new Error(
      'Skill action command templates cannot include secret-like command parts.',
    );
  }
  const parsed = parseBashCommand(withSkillRoot);
  if (!parsed.ok) {
    throw new Error(`Invalid skill action command template: ${parsed.reason}`);
  }
  if (parsed.leaves.length !== 1) {
    throw new Error(
      'Skill action command templates must contain exactly one command leaf.',
    );
  }
  const normalized = normalizeBashLeafRuleContent(parsed.leaves[0]);
  if (!normalized) {
    throw new Error('Skill action command template must resolve to a command.');
  }
  const stableNormalized = normalized.startsWith('./')
    ? normalized.slice(2)
    : normalized;
  if (
    stableNormalized !== skillDir &&
    !stableNormalized.startsWith(`${skillDir}/`)
  ) {
    throw new Error(
      `Skill action command template must run under ${skillDir}.`,
    );
  }
  const readableRule = `${RUN_COMMAND_TOOL_NAME}(${stableNormalized})`;
  const readable = validateReadableAgentToolRule(readableRule);
  if (!readable.ok) {
    throw new Error(
      `Invalid skill action command template: ${readable.reason}`,
    );
  }
  const persistent = validatePersistentRequestPermissionRule(readableRule);
  if (!persistent.ok) {
    throw new Error(
      `Invalid skill action command template: ${persistent.reason}`,
    );
  }
  return stableNormalized;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Skill action ${key} is required.`);
  }
  return value.trim();
}

function stringArray(
  raw: unknown,
  field: string,
  options: { optional?: boolean } = {},
): string[] {
  if (raw === undefined && options.optional) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`Skill action ${field} must be an array.`);
  }
  return raw.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(
        `Skill action ${field} entries must be non-empty strings.`,
      );
    }
    return entry.trim();
  });
}

function hasEnvAssignmentToken(command: string): boolean {
  return command
    .split(/\s+/)
    .some((part) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(part));
}

function hasSecretLikeCommandPart(command: string): boolean {
  const parts = command.split(/\s+/);
  return parts.some((part) =>
    /(?:^|[-_])(token|secret|password|api[_-]?key|credential)(?:$|[-_=])/i.test(
      part,
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
