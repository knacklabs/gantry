import { firstPersistentRule } from '../domain/permission-decision.js';
import type { PermissionApprovalRequest } from '../domain/types.js';
import { generatedRuntimeSkillPathDisplay } from '../shared/generated-runtime-paths.js';
import { parseSemanticCapabilityRule } from '../shared/semantic-capability-ids.js';
import { formatPermissionReceiptActionSummary } from './permission-interaction.js';
import { runtimeDisplayCommand } from './permission-tool-input-format.js';
import { sanitizeReceiptDetail } from './permission-text-sanitizer.js';

export interface StructuredPermissionReceiptActionSummary {
  text: string;
  bulkEligible: boolean;
}

const FILE_ACTION_TOOLS = new Set([
  'Edit',
  'FileEdit',
  'FileRead',
  'FileWrite',
  'MultiEdit',
  'Read',
  'Write',
]);
const PATTERN_TOOLS = new Set(['FileSearch', 'Glob', 'Grep']);
const BULK_SCOPE_MARKUP_DENYLIST = [
  '[',
  '](',
  '`',
  '*',
  '_',
  '~',
  '<',
  '>',
  '|',
];

function usesCapabilitySummary(request: PermissionApprovalRequest): boolean {
  const rule = firstPersistentRule(request);
  const ruleId = rule ? parseSemanticCapabilityRule(rule) : undefined;
  const inputId = request.toolInput?.capabilityId;
  const capabilityId =
    ruleId ??
    request.interaction?.requestContext?.capabilityId ??
    (typeof inputId === 'string' ? inputId.trim() : undefined);
  if (capabilityId?.startsWith('skill.')) return false;
  return Boolean(
    capabilityId ||
    request.interaction?.requestContext?.capabilityDisplayName?.trim() ||
    (typeof request.toolInput?.capabilityDisplayName === 'string' &&
      request.toolInput.capabilityDisplayName.trim()),
  );
}

export function formatStructuredPermissionReceiptActionSummary(
  request: PermissionApprovalRequest | undefined,
): StructuredPermissionReceiptActionSummary {
  const text = formatPermissionReceiptActionSummary(request);
  if (!request) return { text, bulkEligible: false };
  if (usesCapabilitySummary(request)) {
    return { text, bulkEligible: false };
  }
  const input = request.toolInput;
  if (
    !input ||
    typeof input !== 'object' ||
    request.toolInputSanitized === true ||
    (request.toolInputSanitizedPaths?.length ?? 0) > 0
  ) {
    return { text, bulkEligible: false };
  }
  const scope = bulkEligibleScope(request.toolName, input);
  return {
    text,
    bulkEligible: scope !== null && sanitizeReceiptDetail(scope) === scope,
  };
}

function bulkEligibleScope(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName === 'Bash' || toolName === 'RunCommand') {
    const command = onlyStringField(input, 'command');
    if (!command) return null;
    const display = runtimeDisplayCommand(command);
    if (generatedRuntimeSkillPathDisplay(display.command)) return null;
    const rendered = [...display.runtimeEnvAssignments, display.command].join(
      ' ',
    );
    return rendered === command ? command : null;
  }
  if (FILE_ACTION_TOOLS.has(toolName)) {
    return onlyStringField(input, 'file_path');
  }
  if (toolName === 'WebFetch') return onlyStringField(input, 'url');
  if (PATTERN_TOOLS.has(toolName)) return onlyStringField(input, 'pattern');
  return null;
}

function onlyStringField(
  input: Record<string, unknown>,
  key: string,
): string | null {
  if (Object.keys(input).length !== 1 || !(key in input)) return null;
  const value = input[key];
  return typeof value === 'string' &&
    value.trim() === value &&
    value &&
    !BULK_SCOPE_MARKUP_DENYLIST.some((token) => value.includes(token)) &&
    !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)
    ? value
    : null;
}
