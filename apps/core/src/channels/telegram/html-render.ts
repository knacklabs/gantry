import type { UserQuestionRequest } from '../../domain/types.js';
import type { AgentTodoItem } from '../../domain/ports/task-lifecycle.js';
import { formatAgentTodoLine } from '../agent-todo-render.js';
import {
  PERMISSION_GLYPH,
  type PermissionPromptParts,
} from '../permission-interaction.js';
import { truncateText } from './channel-shared.js';

/**
 * Escape text for Telegram HTML parse mode. Per the Bot API, only `&`, `<` and
 * `>` must be escaped; doing so makes any dynamic, already-sanitized content
 * safe to interpolate into HTML markup.
 */
export function escapeTelegramHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const CODE_FENCES = new Set(['```', '```diff', '```json', '```markdown']);

/**
 * Escape a non-fenced line for Telegram HTML, converting inline `code` spans
 * into <code> (otherwise the backticks render literally). Each segment is
 * HTML-escaped; backtick-delimited spans become <code>…</code>.
 */
function escapeInlineWithCode(line: string): string {
  if (!line.includes('`')) return escapeTelegramHtml(line);
  return line
    .split(/(`[^`]+`)/)
    .map((segment) =>
      segment.length >= 2 && segment.startsWith('`') && segment.endsWith('`')
        ? `<code>${escapeTelegramHtml(segment.slice(1, -1))}</code>`
        : escapeTelegramHtml(segment),
    )
    .join('');
}

/**
 * Render permission body lines (which may contain ``` fenced code regions, the
 * convention emitted by formatPermissionToolInputLines) into Telegram HTML:
 * fenced regions become <pre> blocks; every other line is HTML-escaped.
 */
export function renderBodyLinesHtml(lines: string[]): string {
  const out: string[] = [];
  let code: string[] | null = null;
  for (const line of lines) {
    if (CODE_FENCES.has(line)) {
      if (code === null) {
        code = [];
      } else {
        out.push(`<pre>${escapeTelegramHtml(code.join('\n'))}</pre>`);
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    out.push(escapeInlineWithCode(line));
  }
  if (code !== null) {
    // Unterminated fence: render what we collected rather than dropping it.
    out.push(`<pre>${escapeTelegramHtml(code.join('\n'))}</pre>`);
  }
  return out.join('\n');
}

export function renderPermissionPromptHtml(
  parts: PermissionPromptParts,
): string {
  const segments = [
    `<b>${PERMISSION_GLYPH} ${escapeTelegramHtml(parts.title)}</b>`,
  ];
  if (parts.bodyLines.length > 0) {
    segments.push('', renderBodyLinesHtml(parts.bodyLines));
  }
  if (parts.contextLines.length > 0) {
    segments.push(
      '',
      parts.contextLines
        .map((line) => `<i>${escapeTelegramHtml(line)}</i>`)
        .join('\n'),
    );
  }
  segments.push('', `<i>Reply in ${parts.replyInMinutes}m</i>`);
  return segments.join('\n');
}

export function renderUserQuestionPromptHtml(
  question: UserQuestionRequest['questions'][number],
): string {
  const lines = [
    `<b>❓ ${escapeTelegramHtml(question.header)}</b>`,
    escapeTelegramHtml(question.question),
    '',
  ];
  question.options.forEach((option, optionIndex) => {
    const description = option.description
      ? ` — ${escapeTelegramHtml(truncateText(option.description, 180))}`
      : '';
    lines.push(
      `${optionIndex + 1}. <b>${escapeTelegramHtml(option.label)}</b>${description}`,
    );
    if (option.preview) {
      lines.push(
        `   <i>Preview: ${escapeTelegramHtml(truncateText(option.preview, 180))}</i>`,
      );
    }
  });
  if (question.multiSelect) {
    lines.push('', '<i>Select one or more, then tap Done.</i>');
  }
  return lines.join('\n');
}

// Telegram messages cap at 4096 chars; keep a margin for the header and tags.
const AGENT_TODO_MAX_LENGTH = 3800;

/**
 * Render an agent todo/plan as a single Telegram HTML message: a bold title
 * plus an expandable blockquote of status lines. Long lists are truncated with
 * a trailing "… (N more)" so the message stays within the length limit.
 */
export function renderAgentTodoHtml(render: {
  summary: string | null;
  items: AgentTodoItem[];
}): string {
  const title = render.summary?.trim()
    ? escapeTelegramHtml(render.summary.trim())
    : '📋 Plan';
  const header = `<b>${title}</b>`;
  const lines: string[] = [];
  let used = header.length + 35; // header + blockquote tags + "(N more)" margin
  let dropped = 0;
  for (let index = 0; index < render.items.length; index += 1) {
    const item = render.items[index];
    const line = formatAgentTodoLine(item, escapeTelegramHtml);
    if (used + line.length + 1 > AGENT_TODO_MAX_LENGTH) {
      dropped = render.items.length - index;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (dropped > 0) lines.push(`… (${dropped} more)`);
  return `${header}\n<blockquote expandable>${lines.join('\n')}</blockquote>`;
}
