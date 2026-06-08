import type { PermissionApprovalRequest } from '../domain/types.js';
import { firstDestructiveRedirectTarget } from '../shared/bash-command-parser.js';
import { generatedRuntimeSkillPathDisplay } from '../shared/generated-runtime-paths.js';

const PERMISSION_JSON_MAX_DEPTH = 2;
const PERMISSION_JSON_MAX_KEYS = 12;
const PERMISSION_JSON_MAX_ARRAY_ITEMS = 8;
const SENSITIVE_INPUT_KEY_PATTERN =
  /(secret|token|password|credential|api[_-]?key|private[_-]?key|session|cookie|authorization)/i;
const REDACTION_MARKER_PATTERN =
  /\[REDACTED_(?:SECRET|POTENTIALLY_SENSITIVE)\]/;

type PermissionTextSanitizer = (
  input: string,
  head: number,
  tail: number,
) => string;

export function formatPermissionToolInputLines(
  request: PermissionApprovalRequest,
  sanitizePermissionText: PermissionTextSanitizer,
  options: { sanitizeCommandText?: PermissionTextSanitizer } = {},
): string[] {
  if (!request.toolInput || typeof request.toolInput !== 'object') return [];
  const input = request.toolInput;
  if (typeof input.command === 'string' && input.command.trim()) {
    const generatedSkillPath = generatedRuntimeSkillPathDisplay(
      input.command.trim(),
    );
    if (generatedSkillPath) {
      const redirectTarget = firstDestructiveRedirectTarget(input.command);
      return [
        'Command: generated skill action command; runtime path hidden.',
        `Action: ${sanitizePermissionText(generatedSkillPath, 180, 80)}`,
        ...(redirectTarget ? [`Redirect: ${redirectTarget}`] : []),
      ];
    }
    const command = (options.sanitizeCommandText ?? sanitizePermissionText)(
      input.command.trim(),
      900,
      300,
    );
    const redirectTarget = firstDestructiveRedirectTarget(input.command);
    if (hasRedactionMarker(command)) {
      const program = shellProgramLabel(input.command);
      return [
        'Command: hidden because it may contain sensitive values.',
        ...(program
          ? [`Program: ${sanitizePermissionText(program, 120, 40)}`]
          : []),
        ...(redirectTarget ? [`Redirect: ${redirectTarget}`] : []),
      ];
    }
    return [
      'Command:',
      '```',
      command,
      '```',
      ...(redirectTarget ? [`Redirect: ${redirectTarget}`] : []),
    ];
  }
  if (request.toolName === 'Edit' || request.toolName === 'Write') {
    const lines = formatFileToolInputLines(
      request.toolName,
      input,
      sanitizePermissionText,
    );
    if (lines.length > 0) return lines;
  }
  const fieldLines = formatKnownToolInputFields(
    request.toolName,
    input,
    sanitizePermissionText,
  );
  if (fieldLines.length > 0) return fieldLines;
  try {
    const json = sanitizePermissionText(
      boundedJsonPreview(input, sanitizePermissionText),
      450,
      150,
    );
    return ['Input:', '```json', json, '```'];
  } catch {
    return ['Input: [unserializable]'];
  }
}

function formatFileToolInputLines(
  toolName: string,
  input: Record<string, unknown>,
  sanitizePermissionText: PermissionTextSanitizer,
): string[] {
  const lines: string[] = [];
  if (typeof input.file_path === 'string' && input.file_path.trim()) {
    lines.push(
      `File: ${sanitizePermissionText(input.file_path.trim(), 200, 80)}`,
    );
  }
  const diffLines: string[] = [];
  if (toolName === 'Edit') {
    if (typeof input.old_string === 'string' && input.old_string.trim()) {
      diffLines.push(
        `-${sanitizePermissionText(input.old_string.trim(), 200, 100)}`,
      );
    }
    if (typeof input.new_string === 'string' && input.new_string.trim()) {
      diffLines.push(
        `+${sanitizePermissionText(input.new_string.trim(), 200, 100)}`,
      );
    }
  } else if (typeof input.content === 'string' && input.content.trim()) {
    diffLines.push(
      `+${sanitizePermissionText(input.content.trim(), 200, 100)}`,
    );
  }
  if (diffLines.length > 0) {
    lines.push('Change:', '```diff', ...diffLines, '```');
  }
  return lines;
}

function boundedJsonPreview(
  input: Record<string, unknown>,
  sanitizePermissionText: PermissionTextSanitizer,
): string {
  return JSON.stringify(
    boundedJsonValue(input, 0, sanitizePermissionText),
    null,
    2,
  );
}

function boundedJsonValue(
  value: unknown,
  depth: number,
  sanitizePermissionText: PermissionTextSanitizer,
): unknown {
  if (typeof value === 'string') {
    return sanitizePermissionText(value, 160, 80);
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, PERMISSION_JSON_MAX_ARRAY_ITEMS)
      .map((item) => boundedJsonValue(item, depth + 1, sanitizePermissionText));
    if (value.length > items.length) {
      items.push(`... ${value.length - items.length} more item(s) omitted`);
    }
    return items;
  }
  if (value && typeof value === 'object') {
    if (depth >= PERMISSION_JSON_MAX_DEPTH) return '[nested object omitted]';
    const out: Record<string, unknown> = {};
    let seen = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (seen >= PERMISSION_JSON_MAX_KEYS) {
        out.__omitted_keys = 'more';
        break;
      }
      seen += 1;
      const entry = (value as Record<string, unknown>)[key];
      out[key] = SENSITIVE_INPUT_KEY_PATTERN.test(key)
        ? '[hidden]'
        : boundedJsonValue(entry, depth + 1, sanitizePermissionText);
    }
    return out;
  }
  return sanitizePermissionText(String(value), 160, 80);
}

function hasRedactionMarker(value: string): boolean {
  return REDACTION_MARKER_PATTERN.test(value);
}

function shellProgramLabel(command: string): string | null {
  const first = command
    .trim()
    .match(/^(?:env\s+)?(?:[\w.-]+=\S+\s+)*(['"]?)([^'"`\s;|&()<>]+)\1/);
  if (!first?.[2]) return null;
  const program = first[2].split('/').pop() || first[2];
  return program || null;
}

function formatKnownToolInputFields(
  toolName: string,
  input: Record<string, unknown>,
  sanitizePermissionText: PermissionTextSanitizer,
): string[] {
  const lines: string[] = [];
  const add = (label: string, value: unknown, limit = 300) => {
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const text = String(value).trim();
    if (!text) return;
    lines.push(`${label}: ${sanitizePermissionText(text, limit, 100)}`);
  };
  if (toolName === 'Read') add('Path', input.file_path);
  if (toolName === 'LS') add('Path', input.path);
  if (toolName === 'Glob') {
    add('Pattern', input.pattern);
    add('Path', input.path);
  }
  if (toolName === 'Grep') {
    add('Pattern', input.pattern);
    add('Path', input.path);
    add('Include', input.include);
  }
  if (toolName === 'WebFetch') {
    add('URL', input.url);
    add('Prompt', input.prompt, 300);
  }
  if (toolName.startsWith('mcp__gantry__browser_')) {
    add('URL', input.url);
    add('Selector', input.selector);
    add('Text', input.text);
    add('Path', input.path);
    add('Key', input.key);
  }
  if (
    toolName.startsWith('mcp__gantry__scheduler_') ||
    toolName.startsWith('scheduler_')
  ) {
    add('Job ID', input.job_id ?? input.jobId);
    add('Name', input.name);
    add(
      'Schedule',
      input.schedule ?? input.schedule_value ?? input.scheduleValue,
    );
    add('Prompt', input.prompt, 300);
  }
  return lines;
}
