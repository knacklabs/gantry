import type { UserQuestionRequest } from '../../domain/types.js';
import type { AgentTodoItem } from '../../domain/ports/task-lifecycle.js';
import { type PermissionPromptParts } from '../permission-interaction.js';
/**
 * Escape text for Telegram HTML parse mode. Per the Bot API, only `&`, `<` and
 * `>` must be escaped; doing so makes any dynamic, already-sanitized content
 * safe to interpolate into HTML markup.
 */
export declare function escapeTelegramHtml(input: string): string;
/**
 * Render permission body lines (which may contain ``` fenced code regions, the
 * convention emitted by formatPermissionToolInputLines) into Telegram HTML:
 * fenced regions become <pre> blocks; every other line is HTML-escaped.
 */
export declare function renderBodyLinesHtml(lines: string[]): string;
export declare function renderPermissionPromptHtml(parts: PermissionPromptParts, options?: {
    includeFullView?: boolean;
}): string;
export declare function renderUserQuestionPromptHtml(question: UserQuestionRequest['questions'][number]): string;
/**
 * Render an agent todo/plan as a single Telegram HTML message: a bold title
 * plus an expandable blockquote of status lines. Long lists are truncated with
 * a trailing "… (N more)" so the message stays within the length limit.
 */
export declare function renderAgentTodoHtml(render: {
    summary: string | null;
    items: AgentTodoItem[];
    headline?: string | null;
    status?: 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
    cardKind?: 'todo' | 'progress';
}): string;
