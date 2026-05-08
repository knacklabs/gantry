import {
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../../domain/types.js';

const SLACK_LIMITS = { buttonText: 75, actionValue: 2000 } as const;

export function truncateSlackText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

export function truncateSlackButtonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'Option';
  return truncateSlackText(trimmed, SLACK_LIMITS.buttonText);
}

export function encodeSlackActionValue(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= SLACK_LIMITS.actionValue) {
    return serialized;
  }
  return JSON.stringify({
    requestId: value.requestId,
    questionIndex: value.questionIndex,
  });
}

export function parseSlackUserQuestionActionValue(
  rawValue: string | undefined,
): { requestId: string; questionIndex: number; optionIndex?: number } | null {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue) as {
      requestId?: unknown;
      questionIndex?: unknown;
      optionIndex?: unknown;
    };
    if (
      typeof parsed.requestId !== 'string' ||
      !Number.isInteger(parsed.questionIndex)
    ) {
      return null;
    }
    if (
      parsed.optionIndex !== undefined &&
      !Number.isInteger(parsed.optionIndex)
    ) {
      return null;
    }
    return {
      requestId: parsed.requestId,
      questionIndex: parsed.questionIndex as number,
      ...(typeof parsed.optionIndex === 'number'
        ? { optionIndex: parsed.optionIndex as number }
        : {}),
    };
  } catch {
    return null;
  }
}

export function formatSlackUserQuestionPromptText(
  request: UserQuestionRequest,
  question: UserQuestionRequest['questions'][number],
  timeoutMs: number,
): string {
  const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
  const lines = [
    `*${question.header}*`,
    `Source: ${truncateSlackText(request.sourceAgentFolder, 80)}`,
  ];
  if (request.threadId) {
    lines.push(`Thread: ${truncateSlackText(request.threadId, 80)}`);
  }
  lines.push(question.question, '');
  question.options.forEach((option, optionIndex) => {
    const description = option.description
      ? ` — ${truncateSlackText(option.description, 180)}`
      : '';
    lines.push(`${optionIndex + 1}. ${option.label}${description}`);
    if (option.preview) {
      lines.push(`Preview: ${truncateSlackText(option.preview, 180)}`);
    }
  });
  lines.push('');
  if (question.multiSelect) {
    lines.push('Select one or more options, then click Done.');
  } else {
    lines.push('Select one option.');
  }
  lines.push(`Reply timeout: ${timeoutMinutes} minute(s)`);
  return lines.join('\n');
}

export function formatSlackPermissionToolInputLines(
  request: PermissionApprovalRequest,
): string[] {
  if (!request.toolInput || typeof request.toolInput !== 'object') return [];
  const input = request.toolInput;
  if (
    request.toolName === 'Bash' &&
    typeof input.command === 'string' &&
    input.command.trim()
  ) {
    return [`Command: \`${truncateSlackText(input.command.trim(), 300)}\``];
  }
  if (request.toolName === 'Edit' || request.toolName === 'Write') {
    const lines: string[] = [];
    if (typeof input.file_path === 'string' && input.file_path.trim()) {
      lines.push(`File: ${truncateSlackText(input.file_path.trim(), 250)}`);
    }
    if (typeof input.old_string === 'string' && input.old_string.trim()) {
      lines.push(
        `Replacing: ${truncateSlackText(input.old_string.trim(), 150)}`,
      );
    }
    if (typeof input.new_string === 'string' && input.new_string.trim()) {
      lines.push(`With: ${truncateSlackText(input.new_string.trim(), 150)}`);
    }
    if (lines.length > 0) return lines;
  }
  try {
    return [`Input: ${truncateSlackText(JSON.stringify(input), 300)}`];
  } catch {
    return ['Input: [unserializable]'];
  }
}
