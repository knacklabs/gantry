import type {
  PermissionApprovalRequest,
  InteractionFile,
} from '../domain/types.js';
import {
  redactSensitiveText,
  sanitizeOutboundLlmText,
} from '../shared/sensitive-material.js';
import { escapeMarkdownFenceDelimiters } from './permission-fenced-content.js';
import { runtimeDisplayCommand } from './permission-tool-input-format.js';

export interface PermissionPromptFullView {
  label: string;
  title: string;
  filename: string;
  content: string;
}

export function buildPermissionPromptFullView(
  request: PermissionApprovalRequest,
): PermissionPromptFullView | undefined {
  const input =
    request.toolInput && typeof request.toolInput === 'object'
      ? request.toolInput
      : undefined;
  const settingsYaml =
    typeof input?.replacementYaml === 'string' && input.replacementYaml.trim()
      ? input.replacementYaml.trim()
      : undefined;
  if (settingsYaml) {
    return fullView(
      'View settings change',
      'Settings change',
      'settings-change.yaml',
      settingsYaml,
    );
  }
  const diffPreview =
    typeof input?.diffPreview === 'string' && input.diffPreview.trim()
      ? input.diffPreview.trim()
      : undefined;
  if (diffPreview) {
    return fullView(
      'View diff',
      'Full diff',
      'permission-diff.diff',
      diffPreview,
    );
  }
  const fileDiff = fullFileDiff(request.toolName, input);
  if (fileDiff) {
    return fullView('View diff', 'Full diff', 'permission-diff.diff', fileDiff);
  }
  const command =
    typeof input?.command === 'string' && input.command.trim()
      ? runtimeDisplayCommand(input.command.trim()).command
      : undefined;
  if (command) {
    return fullView(
      'View full command',
      'Full command',
      'permission-command.txt',
      command,
    );
  }
  const file = request.interaction?.files?.find(
    (candidate) => candidate.preview && !candidate.truncated,
  );
  if (file?.preview) {
    const isSettings = request.toolName === 'request_settings_update';
    const isMcpCapabilityScope = file.path === 'mcp-capability-scope.txt';
    return fullView(
      isSettings
        ? 'View settings change'
        : isMcpCapabilityScope
          ? 'View MCP scope'
          : 'View diff',
      isSettings
        ? 'Settings change'
        : isMcpCapabilityScope
          ? 'MCP capability scope'
          : 'Full payload',
      isSettings
        ? 'settings-change.yaml'
        : isMcpCapabilityScope
          ? file.path
          : 'permission-payload.txt',
      file.preview,
    );
  }
  return undefined;
}

export function formatInteractionDetailLine(
  label: string,
  value: string,
  mono: boolean | undefined,
  sanitizePermissionText: (input: string, head: number, tail: number) => string,
): string {
  const text = sanitizePermissionText(value, 200, 100);
  return `${label}: ${mono ? '`' : ''}${text}${mono ? '`' : ''}`;
}

export function formatInteractionFileLines(
  files: InteractionFile[],
  sanitizePermissionText: (input: string, head: number, tail: number) => string,
): string[] {
  const lines: string[] = [];
  files.slice(0, 3).forEach((file, index) => {
    const path = sanitizePermissionText(file.path, 160, 60);
    const details = [
      typeof file.sizeBytes === 'number'
        ? formatApproxBytes(file.sizeBytes)
        : null,
      file.contentHash ? `sha256 ${file.contentHash.slice(0, 16)}` : null,
    ].filter(Boolean);
    lines.push(
      `Review file${files.length > 1 ? ` ${index + 1}` : ''}: ${path}${
        details.length > 0 ? ` (${details.join(', ')})` : ''
      }`,
    );
    if (file.preview && !file.truncated) {
      lines.push(
        'Full content:',
        '```markdown',
        escapeMarkdownFenceDelimiters(
          sanitizePermissionText(file.preview, file.preview.length, 0),
        ),
        '```',
      );
    } else if (file.preview) {
      lines.push(
        'Preview is truncated; review the full artifact before allowing.',
      );
    }
  });
  if (files.length > 3) lines.push(`+${files.length - 3} more review files`);
  return lines;
}

function fullView(
  label: string,
  title: string,
  filename: string,
  content: string,
): PermissionPromptFullView {
  return {
    label,
    title,
    filename,
    content: sanitizeFullPermissionText(content),
  };
}

function fullFileDiff(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!input) return undefined;
  if (toolName === 'Edit') {
    const lines: string[] = [];
    if (typeof input.old_string === 'string' && input.old_string.trim()) {
      lines.push(`-${input.old_string.trim()}`);
    }
    if (typeof input.new_string === 'string' && input.new_string.trim()) {
      lines.push(`+${input.new_string.trim()}`);
    }
    return lines.length > 0 ? lines.join('\n') : undefined;
  }
  if (
    toolName === 'Write' &&
    typeof input.content === 'string' &&
    input.content.trim()
  ) {
    return input.content
      .trim()
      .split(/\r?\n/)
      .map((line) => `+${line}`)
      .join('\n');
  }
  return undefined;
}

function sanitizeFullPermissionText(input: string): string {
  const result = sanitizeOutboundLlmText(redactSensitiveText(input));
  return result.blocked ? 'Sensitive detail hidden.' : result.text;
}

function formatApproxBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`;
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
