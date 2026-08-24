import type { PermissionApprovalUpdate } from './permission-approval-types.js';
import {
  publicGantryToolNameForSdkTool,
  RUN_COMMAND_TOOL_NAME,
} from './agent-tool-references.js';
import { validateDurableAccessRule } from './durable-access-policy.js';
import {
  isValidSemanticCapabilityId,
  semanticCapabilityRule,
} from './semantic-capability-ids.js';
import type { SemanticCapabilityDefinition } from './semantic-capabilities.js';

export const UNPROJECTED_ACCESS_GRANTED_MESSAGE =
  'Granted for this job; available from the next run';

export const UNPROJECTED_ACCESS_ACTIVITY_DETAIL_PREFIX = 'unprojected_access:';

export type JobPermissionOutcome =
  | 'approved'
  | 'approved_unprojected'
  | 'denied'
  | 'policy_changed'
  | 'setup_required';

const UNPROJECTED_ACCESS_META_KEY = 'gantryUnprojectedAccessIdentity';

export function unprojectedAccessPermissionSuggestions(
  toolInput: Record<string, unknown>,
  options: {
    semanticCapabilityDefinitions?: Record<
      string,
      SemanticCapabilityDefinition
    >;
  } = {},
): PermissionApprovalUpdate[] | undefined {
  if (
    toolInput.temporaryOnly === true ||
    (toolInput.permissionKind && toolInput.permissionKind !== 'tool') ||
    toolInput.capabilityRequestSource !== 'request_access'
  ) {
    return undefined;
  }
  const capabilityId = text(toolInput.capabilityId);
  const toolNames = Array.isArray(toolInput.toolNames)
    ? toolInput.toolNames
        .map(text)
        .filter((value): value is string => Boolean(value))
    : [text(toolInput.toolName)].filter((value): value is string =>
        Boolean(value),
      );
  let durableRule: string | undefined;
  if (capabilityId && toolNames.length === 0) {
    if (
      !isValidSemanticCapabilityId(capabilityId) ||
      !options.semanticCapabilityDefinitions?.[capabilityId]
    ) {
      return undefined;
    }
    durableRule = semanticCapabilityRule(capabilityId);
  } else if (!capabilityId && toolNames.length === 1) {
    const toolName = publicGantryToolNameForSdkTool(toolNames[0]!);
    const ruleContent = durableRuleContent(toolInput.rule);
    if (toolName === RUN_COMMAND_TOOL_NAME && !ruleContent) return undefined;
    durableRule =
      toolName === RUN_COMMAND_TOOL_NAME
        ? `${toolName}(${ruleContent})`
        : toolName;
  }
  if (!durableRule) return undefined;
  const validation = validateDurableAccessRule(durableRule, {
    semanticCapabilityDefinitions: options.semanticCapabilityDefinitions,
  });
  if (!validation.ok) return undefined;
  const open = durableRule.indexOf('(');
  const hasRuleContent = open > 0 && durableRule.endsWith(')');
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: [
        {
          toolName: hasRuleContent ? durableRule.slice(0, open) : durableRule,
          ...(hasRuleContent
            ? { ruleContent: durableRule.slice(open + 1, -1) }
            : {}),
        },
      ],
    },
  ];
}

export function unprojectedAccessIdentityFromPermissionRequest(request: {
  toolName?: string;
  toolInput?: Record<string, unknown>;
}): string | undefined {
  const input = request.toolInput;
  if (
    request.toolName !== 'request_permission' ||
    input?.capabilityRequestSource !== 'request_access'
  ) {
    return undefined;
  }
  const capabilityId = text(input.capabilityId);
  if (capabilityId) return capabilityId;
  const toolNames = Array.isArray(input.toolNames)
    ? input.toolNames
        .map(text)
        .filter((value): value is string => Boolean(value))
    : [];
  if (toolNames.length > 0) return toolNames.join(', ');
  const toolName = text(input.toolName);
  if (toolName) return toolName;
  const serverName = text(input.mcpServerName);
  const patterns = Array.isArray(input.mcpToolPatterns)
    ? input.mcpToolPatterns
        .map(text)
        .filter((value): value is string => Boolean(value))
    : [];
  if (serverName && patterns.length > 0) {
    return `${serverName}: ${patterns.join(', ')}`;
  }
  return text(input.capabilityDisplayName);
}

export function jobPermissionOutcomeForResponse(input: {
  request: { toolName?: string; toolInput?: Record<string, unknown> };
  responseKind: Exclude<JobPermissionOutcome, 'approved_unprojected'>;
}): {
  outcome: JobPermissionOutcome;
  unprojectedAccessIdentity?: string;
} {
  const identity =
    input.responseKind === 'approved'
      ? unprojectedAccessIdentityFromPermissionRequest(input.request)
      : undefined;
  return identity
    ? {
        outcome: 'approved_unprojected',
        unprojectedAccessIdentity: identity,
      }
    : { outcome: input.responseKind };
}

export function withUnprojectedAccessGrantMetadata<T extends object>(
  result: T,
  identity: string,
): T & { _meta: Record<string, unknown> } {
  const current = (result as { _meta?: unknown })._meta;
  const meta =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  return {
    ...result,
    _meta: {
      ...meta,
      [UNPROJECTED_ACCESS_META_KEY]: boundedIdentity(identity),
    },
  };
}

export function unprojectedAccessIdentityFromToolResult(
  value: unknown,
): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const meta = (value as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return undefined;
  }
  return text((meta as Record<string, unknown>)[UNPROJECTED_ACCESS_META_KEY]);
}

export function unprojectedAccessActivityDetail(identity: string): string {
  return `${UNPROJECTED_ACCESS_ACTIVITY_DETAIL_PREFIX}${encodeURIComponent(
    boundedIdentity(identity),
  )}`;
}

export function unprojectedAccessIdentityFromActivityDetail(
  detail: unknown,
): string | undefined {
  const value = text(detail);
  if (!value?.startsWith(UNPROJECTED_ACCESS_ACTIVITY_DETAIL_PREFIX)) {
    return undefined;
  }
  try {
    return boundedIdentity(
      decodeURIComponent(
        value.slice(UNPROJECTED_ACCESS_ACTIVITY_DETAIL_PREFIX.length),
      ),
    );
  } catch {
    return undefined;
  }
}

function boundedIdentity(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function durableRuleContent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized && normalized.length <= 2_048 ? normalized : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? boundedIdentity(value)
    : undefined;
}
