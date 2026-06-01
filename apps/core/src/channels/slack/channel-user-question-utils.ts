import { UserQuestionRequest } from '../../domain/types.js';

const SLACK_LIMITS = { buttonText: 75, actionValue: 2000 } as const;

export function truncateSlackText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // Reserve room for the ellipsis so the result never exceeds maxLen — Slack
  // rejects the whole message when a header (150) or button (75) runs over.
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
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

/** Question + options, without the header (the header gets its own block). */
export function formatSlackUserQuestionBody(
  question: UserQuestionRequest['questions'][number],
): string {
  const lines = [question.question, ''];
  question.options.forEach((option, optionIndex) => {
    const description = option.description
      ? ` — ${truncateSlackText(option.description, 180)}`
      : '';
    lines.push(`${optionIndex + 1}. ${option.label}${description}`);
    if (option.preview) {
      lines.push(`Preview: ${truncateSlackText(option.preview, 180)}`);
    }
  });
  if (question.multiSelect) {
    lines.push('', 'Select one or more, then tap Done.');
  }
  return lines.join('\n');
}

export function formatSlackUserQuestionPromptText(
  _request: UserQuestionRequest,
  question: UserQuestionRequest['questions'][number],
  _timeoutMs: number,
): string {
  return `*${question.header}*\n${formatSlackUserQuestionBody(question)}`;
}
