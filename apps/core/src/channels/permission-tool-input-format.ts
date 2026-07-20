import type { PermissionApprovalRequest } from '../domain/types.js';
import {
  destructiveBashCommandHint,
  firstDestructiveRedirectTarget,
  summarizeBashCommandPrograms,
} from '../shared/bash-command-parser.js';
import { generatedRuntimeSkillPathDisplay } from '../shared/generated-runtime-paths.js';
import {
  stripHostInjectedEnvPrefix,
  stripRuntimeEnvPrefix,
} from '../shared/runtime-env-command.js';
import { escapeMarkdownFenceDelimiters } from './permission-fenced-content.js';

const PERMISSION_JSON_MAX_KEYS = 12;
const PERMISSION_JSON_MAX_ARRAY_ITEMS = 8;
const SENSITIVE_INPUT_KEY_PATTERN =
  /(secret|token|password|credential|api[_-]?key|private[_-]?key|session|cookie|authorization)/i;
// Internal runtime plumbing identifiers (chat jids, ipc dirs, run handles,
// sandbox/agent/skill ids). Carry no decision value for the user and can leak
// internal topology, so the generic fallback drops them entirely rather than
// rendering them as visible key/value lines.
function isInternalPlumbingKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.endsWith('jid') ||
    k.includes('ipcdir') ||
    k.includes('runhandle') ||
    k.includes('sandboxprofile') ||
    k.includes('workspacekey') ||
    k.includes('workspacefolder') ||
    k.endsWith('agentid') ||
    k.endsWith('appid') ||
    k.endsWith('sessionid') ||
    k.endsWith('threadid') ||
    k.endsWith('correlationid') ||
    k.endsWith('skillid') ||
    k.endsWith('profileid')
  );
}
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
    const displayCommand = runtimeDisplayCommand(input.command.trim());
    const leadLine = commandLeadLine(
      input,
      displayCommand.command,
      sanitizePermissionText,
    );
    const riskLines = commandRiskLines(displayCommand.command);
    const generatedSkillPath = generatedRuntimeSkillPathDisplay(
      displayCommand.command,
    );
    if (generatedSkillPath) {
      const runtimeEnvLine =
        displayCommand.runtimeEnvAssignments.length > 0
          ? `Runtime environment: ${sanitizePermissionText(
              displayCommand.runtimeEnvAssignments.join(' '),
              600,
              200,
            )}`
          : null;
      return [
        leadLine,
        'Command: generated skill action command; runtime path hidden.',
        `Action: ${sanitizePermissionText(generatedSkillPath, 180, 80)}`,
        ...(runtimeEnvLine ? [runtimeEnvLine] : []),
        ...riskLines,
      ];
    }
    const command = (options.sanitizeCommandText ?? sanitizePermissionText)(
      displayCommand.command,
      900,
      300,
    );
    if (hasRedactionMarker(command)) {
      const program = shellProgramLabel(displayCommand.command);
      return [
        leadLine,
        'Command: hidden because it may contain sensitive values.',
        ...(program
          ? [`Program: ${sanitizePermissionText(program, 120, 40)}`]
          : []),
        ...riskLines,
      ];
    }
    return [
      leadLine,
      'Command:',
      '```',
      command,
      '```',
      ...(displayCommand.runtimeEnvAssignments.length > 0
        ? [
            `Runtime environment: ${sanitizePermissionText(
              displayCommand.runtimeEnvAssignments.join(' '),
              600,
              200,
            )}`,
          ]
        : []),
      ...riskLines,
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
  // No meaningful arguments (e.g. a read-only tool that takes none): skip the
  // body entirely rather than showing an empty `Input: {}` block.
  if (Object.keys(input).length === 0) return [];
  // Unknown / third-party tool: render top-level args as clean key/value lines
  // (sensitive keys hidden, values sanitized) instead of a raw JSON block.
  const generic = formatGenericInputFields(input, sanitizePermissionText);
  return generic.length > 0 ? ['Input:', ...generic] : [];
}

function labelizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatGenericInputFields(
  input: Record<string, unknown>,
  sanitizePermissionText: PermissionTextSanitizer,
): string[] {
  const lines: string[] = [];
  let shown = 0;
  for (const [key, value] of Object.entries(input)) {
    if (shown >= PERMISSION_JSON_MAX_KEYS) {
      lines.push('  …');
      break;
    }
    if (isInternalPlumbingKey(key)) continue;
    if (SENSITIVE_INPUT_KEY_PATTERN.test(key)) {
      lines.push(`  ${labelizeKey(key)}: [hidden]`);
      shown += 1;
      continue;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      const text = String(value).trim();
      if (!text) continue;
      lines.push(
        `  ${labelizeKey(key)}: ${sanitizePermissionText(text, 200, 80)}`,
      );
      shown += 1;
    } else if (Array.isArray(value)) {
      const scalars = value
        .filter((item) => typeof item === 'string' || typeof item === 'number')
        .map(String);
      if (scalars.length === 0) continue;
      lines.push(
        `  ${labelizeKey(key)}: ${sanitizePermissionText(
          scalars.slice(0, PERMISSION_JSON_MAX_ARRAY_ITEMS).join(', '),
          200,
          60,
        )}`,
      );
      shown += 1;
    }
    // Nested objects are intentionally omitted from the prompt body.
  }
  return lines;
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
        `-${escapeMarkdownFenceDelimiters(
          sanitizePermissionText(input.old_string.trim(), 200, 100),
        )}`,
      );
    }
    if (typeof input.new_string === 'string' && input.new_string.trim()) {
      diffLines.push(
        `+${escapeMarkdownFenceDelimiters(
          sanitizePermissionText(input.new_string.trim(), 200, 100),
        )}`,
      );
    }
  } else if (typeof input.content === 'string' && input.content.trim()) {
    diffLines.push(
      `+${escapeMarkdownFenceDelimiters(
        sanitizePermissionText(input.content.trim(), 200, 100),
      )}`,
    );
  }
  if (diffLines.length > 0) {
    lines.push('Change:', '```diff', ...diffLines, '```');
  }
  return lines;
}

function hasRedactionMarker(value: string): boolean {
  return REDACTION_MARKER_PATTERN.test(value);
}

function commandLeadLine(
  input: Record<string, unknown>,
  command: string,
  sanitizePermissionText: PermissionTextSanitizer,
): string {
  if (typeof input.description === 'string' && input.description.trim()) {
    return `What it does: ${sanitizePermissionText(
      input.description.trim(),
      300,
      100,
    )}`;
  }
  const programs =
    summarizeBashCommandPrograms(command) ?? shellProgramLabel(command);
  return `Runs: ${
    programs ? sanitizePermissionText(programs, 200, 80) : 'command'
  }`;
}

function commandRiskLines(command: string): string[] {
  const lines: string[] = [];
  const redirectTarget = firstDestructiveRedirectTarget(command);
  if (redirectTarget) lines.push(`Redirect: ${redirectTarget}`);
  const hint = destructiveBashCommandHint(command);
  if (hint) lines.push(`⚠️ ${hint}`);
  return lines;
}

function shellProgramLabel(command: string): string | null {
  const first = command
    .trim()
    .match(/^(?:env\s+)?(?:[\w.-]+=\S+\s+)*(['"]?)([^'"`\s;|&()<>]+)\1/);
  if (!first?.[2]) return null;
  const program = first[2].split('/').pop() || first[2];
  return program || null;
}

export function runtimeDisplayCommand(command: string): {
  command: string;
  runtimeEnvAssignments: string[];
} {
  // Host-injected proxy/CA plumbing carries no decision value for the
  // approver and leaks internal topology — drop it from the prompt entirely.
  // Agent-supplied env assignments (e.g. a non-loopback proxy) still display.
  const parsed = stripRuntimeEnvPrefix(
    stripHostInjectedEnvPrefix(command).command,
  );
  return {
    command: parsed.command,
    runtimeEnvAssignments: parsed.envAssignments,
  };
}

function formatApproxBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes}`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function skillMarkdownPreviewContent(input: Record<string, unknown>): {
  content: string;
  truncated: boolean;
} | null {
  const preview = input.skillMarkdownPreview;
  if (typeof preview !== 'object' || preview === null) return null;
  const record = preview as Record<string, unknown>;
  if (typeof record.content !== 'string') return null;
  const content = record.content.trim();
  if (!content) return null;
  return {
    content,
    truncated: record.truncated === true,
  };
}

function skillReviewFileLines(
  input: Record<string, unknown>,
  sanitizePermissionText: PermissionTextSanitizer,
): string[] {
  if (!Array.isArray(input.files) || input.files.length === 0) return [];
  const lines: string[] = ['Review files:'];
  for (const file of input.files.slice(0, 5)) {
    if (!file || typeof file !== 'object') continue;
    const record = file as Record<string, unknown>;
    const path =
      typeof record.path === 'string'
        ? sanitizePermissionText(record.path, 160, 60)
        : 'unknown';
    const details: string[] = [];
    if (typeof record.sizeBytes === 'number') {
      details.push(formatApproxBytes(record.sizeBytes));
    }
    if (typeof record.contentHash === 'string' && record.contentHash.trim()) {
      details.push(sanitizePermissionText(record.contentHash.trim(), 80, 16));
    }
    lines.push(
      `- ${path}${details.length > 0 ? ` (${details.join(', ')})` : ''}`,
    );
  }
  if (input.files.length > 5) {
    lines.push(`+${input.files.length - 5} more files`);
  }
  return lines;
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
  const addList = (label: string, value: unknown, max = 8) => {
    if (!Array.isArray(value)) return;
    const items = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean);
    if (items.length === 0) return;
    const shown = items.slice(0, max);
    const overflow =
      items.length > shown.length
        ? `, +${items.length - shown.length} more`
        : '';
    lines.push(
      `${label}: ${sanitizePermissionText(shown.join(', '), 280, 80)}${overflow}`,
    );
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
  // Admin request tools carry rich structured payloads; render a clean,
  // human-readable summary instead of dumping raw JSON (which also leaks
  // internal ids like skillId, sandboxProfileId, raw jids, and folders).
  if (toolName === 'request_skill_dependency_install') {
    add('Ecosystem', input.ecosystem, 40);
    addList('Packages', input.packages);
    add('Reason', input.reason, 300);
    add('Activation', input.activation, 80);
    if (Array.isArray(input.commandArgv) && input.commandArgv.length > 0) {
      const argv = input.commandArgv
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean);
      if (argv.length > 0) {
        lines.push(
          'Command:',
          '```',
          escapeMarkdownFenceDelimiters(
            sanitizePermissionText(argv.join(' '), 900, 300),
          ),
          '```',
        );
      }
    }
  }
  if (
    toolName === 'request_skill_install' ||
    toolName === 'request_skill_proposal'
  ) {
    add('Description', input.description, 200);
    add('Install', input.commandSummary, 200);
    if (Array.isArray(input.files) && input.files.length > 0) {
      const size =
        typeof input.totalSizeBytes === 'number'
          ? ` (${formatApproxBytes(input.totalSizeBytes)})`
          : '';
      lines.push(`Files: ${input.files.length}${size}`);
      lines.push(...skillReviewFileLines(input, sanitizePermissionText));
    }
    if (
      Array.isArray(input.requiredEnvVars) &&
      input.requiredEnvVars.length > 0
    ) {
      lines.push(
        'Credentials: required before some skill actions can run; add them in Credential Center.',
      );
    }
    const preview = skillMarkdownPreviewContent(input);
    if (preview) {
      lines.push(
        preview.truncated
          ? 'SKILL.md preview (truncated):'
          : 'SKILL.md preview:',
        '```markdown',
        escapeMarkdownFenceDelimiters(
          sanitizePermissionText(preview.content, 2400, 600),
        ),
        '```',
      );
    }
  }
  if (toolName === 'request_mcp_server') {
    add('Transport', input.transport, 40);
    add('Install', input.origin, 200);
    addList('Tools', input.requestedToolPatterns);
    addList('Needs credentials', input.credentialNeeds);
    addList('Network', input.networkHosts);
  }
  if (toolName === 'register_agent') {
    if (typeof input.trigger === 'string' && input.trigger.trim()) {
      lines.push(
        `Trigger: ${sanitizePermissionText(input.trigger.trim(), 80, 20)}${
          input.requiresTrigger ? ' (required)' : ''
        }`,
      );
    }
  }
  if (toolName === 'request_agent_profile_update') {
    const fileName =
      typeof input.fileName === 'string' ? input.fileName : String(input.file);
    add('File', fileName);
    add('Why', input.summary, 280);
    add('Proposed hash', input.proposedContentHash, 96);
    if (typeof input.proposedContentBytes === 'number') {
      lines.push(`Proposed size: ${input.proposedContentBytes} bytes`);
    }
    if (
      typeof input.proposedContent === 'string' &&
      input.proposedContent.trim()
    ) {
      const proposedContent = input.proposedContent.trim();
      if (proposedContent.length <= 1600) {
        lines.push(
          'Proposed content:',
          '```markdown',
          escapeMarkdownFenceDelimiters(
            sanitizePermissionText(proposedContent, proposedContent.length, 0),
          ),
          '```',
        );
      } else {
        lines.push(
          'Proposed content: full content is attached to the approval evidence; do not approve from this text summary alone.',
        );
      }
    }
    if (typeof input.diffPreview === 'string' && input.diffPreview.trim()) {
      lines.push(
        'Change:',
        '```diff',
        escapeMarkdownFenceDelimiters(
          sanitizePermissionText(input.diffPreview.trim(), 1800, 400),
        ),
        '```',
      );
    }
    lines.push('Applies on the next run.');
  }
  if (toolName === 'request_settings_update') {
    add('Why', input.reason, 280);
    add('Expected revision', input.expectedRevision, 96);
    if (typeof input.authoritative === 'boolean') {
      lines.push(`Authoritative: ${input.authoritative ? 'yes' : 'no'}`);
    }
    if (typeof input.agentCount === 'number') {
      lines.push(`Agents: ${input.agentCount}`);
    }
    addList('Providers', input.providerIds);
    if (Array.isArray(input.diffSummary) && input.diffSummary.length > 0) {
      lines.push(
        'Change summary:',
        ...input.diffSummary
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter(Boolean)
          .slice(0, 12)
          .map((entry) => `  ${sanitizePermissionText(entry, 260, 80)}`),
      );
    }
    lines.push('Applies to settings.yaml after approval.');
  }
  return lines;
}
