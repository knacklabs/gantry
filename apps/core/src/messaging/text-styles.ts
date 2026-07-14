/**
 * parseTextStyles — convert agent Markdown output to channel-native formatting.
 *
 * Code blocks (fenced and inline) are preserved exactly. Marker substitution is
 * applied only to non-code segments.
 */

export type FormattingDialect =
  | 'none'
  | 'markdown-native'
  | 'mrkdwn'
  | 'telegram-html'
  | 'telegram-markdown-v2';

/** Transform Markdown text for the target channel's native format. */
export function parseTextStyles(
  text: string,
  channel: FormattingDialect,
): string {
  if (!text) return text;
  if (channel === 'none' || channel === 'markdown-native') return text;

  const segments = splitProtectedRegions(text);
  return segments
    .map(({ content, protected: isProtected }) =>
      isProtected ? content : transformSegment(content, channel),
    )
    .join('');
}

interface Segment {
  content: string;
  protected: boolean;
}

function splitProtectedRegions(text: string): Segment[] {
  const segments: Segment[] = [];
  const codePattern = /```[\s\S]*?```|`[^`\n]+`/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        content: text.slice(lastIndex, match.index),
        protected: false,
      });
    }
    segments.push({ content: match[0], protected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), protected: false });
  }

  return segments.length > 0 ? segments : [{ content: text, protected: false }];
}

function transformSegment(text: string, channel: FormattingDialect): string {
  let t = text;

  if (channel === 'telegram-markdown-v2') {
    t = t.replace(/___(?=[^\s_])([^_]+?)(?<=[^\s_])___/g, '*_$1_*');
    t = t.replace(/\*\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*\*/g, '*_$1_*');
  }

  t = t.replace(/(?<!\*)\*(?=[^\s*_])([^*\n]+?)(?<=[^\s*_])\*(?!\*)/g, '_$1_');
  t = t.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  if (channel === 'mrkdwn') {
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
  } else if (channel === 'telegram-markdown-v2') {
    t = t.replace(/<u>(.*?)<\/u>/g, '__$1__');
  } else {
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  }
  t = t.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');

  return t;
}
