export function escapeTelegramMarkdownV2Plain(text: string): string {
  return text.replace(/[_*~[\]()`>#+\-=|{}.!\\]/g, '\\$&');
}

export function escapeTelegramMarkdownV2Literal(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

export function escapeTelegramMarkdownV2CodeSegment(segment: string): string {
  if (segment.startsWith('```') && segment.endsWith('```')) {
    const body = segment.slice(3, -3);
    const firstNewline = body.indexOf('\n');
    if (firstNewline === -1) {
      return `\`\`\`${body.replace(/[\\`]/g, '\\$&')}\`\`\``;
    }
    const language = body.slice(0, firstNewline);
    const code = body.slice(firstNewline + 1).replace(/[\\`]/g, '\\$&');
    return `\`\`\`${language}\n${code}\`\`\``;
  }
  const code = segment.slice(1, -1).replace(/[\\`]/g, '\\$&');
  return `\`${code}\``;
}

export function escapeTelegramMarkdownV2LinkSegment(segment: string): string {
  const match = /^\[([\s\S]+)]\(([\s\S]+)\)$/.exec(segment);
  if (!match) return escapeTelegramMarkdownV2Plain(segment);
  const escapedText = escapeTelegramMarkdownV2Plain(match[1]);
  const escapedUrl = match[2].replace(/[)\\]/g, '\\$&');
  return `[${escapedText}](${escapedUrl})`;
}

type EscapeTelegramMarkdownV2Options = {
  preserveStyleMarkers?: boolean;
};

/**
 * Escape text for Telegram MarkdownV2 while preserving markdown formatting
 * markers produced by parseTextStyles (bold/italic/links/code) and model
 * responses that use similarly well-delimited emphasis markers.
 */
export function escapeTelegramMarkdownV2(
  text: string,
  options: EscapeTelegramMarkdownV2Options = {},
): string {
  if (!text) return text;
  const protectedPattern =
    /```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]+\]\((?:\\.|[^\\\n)])+\)/g;
  let out = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = protectedPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out += escapeTelegramMarkdownV2PlainSegment(
        text.slice(lastIndex, match.index),
        options,
      );
    }
    const token = match[0];
    if (token.startsWith('`')) {
      out += escapeTelegramMarkdownV2CodeSegment(token);
    } else {
      out += escapeTelegramMarkdownV2LinkSegment(token);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    out += escapeTelegramMarkdownV2PlainSegment(text.slice(lastIndex), options);
  }
  if (options.preserveStyleMarkers) {
    out = out.replace(/(^|\n)([ \t]*)\\>/g, '$1$2>');
  }
  return out;
}

type TelegramStyleMarker = '_' | '*';

const TELEGRAM_STYLE_MARKERS = new Set<TelegramStyleMarker>(['_', '*']);

function isEscapedAt(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function isWordChar(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function isOpeningBoundary(value: string | undefined): boolean {
  return value === undefined || isWhitespace(value) || /[([{\-]/u.test(value);
}

function isClosingBoundary(value: string | undefined): boolean {
  return value === undefined || isWhitespace(value) || /[)\]}.,!?;:-]/u.test(value);
}

function isValidOpeningMarker(
  text: string,
  index: number,
  marker: TelegramStyleMarker,
): boolean {
  const previous = text[index - 1];
  const next = text[index + 1];
  if (next === undefined || isWhitespace(next)) return false;
  if (!isOpeningBoundary(previous)) return false;
  if (marker === '_' && isWordChar(previous) && isWordChar(next)) return false;
  return true;
}

function isValidClosingMarker(
  text: string,
  index: number,
  marker: TelegramStyleMarker,
): boolean {
  const previous = text[index - 1];
  const next = text[index + 1];
  if (previous === undefined || isWhitespace(previous)) return false;
  if (!isClosingBoundary(next)) return false;
  if (marker === '_' && isWordChar(previous) && isWordChar(next)) return false;
  return true;
}

function escapeTelegramMarkdownV2PlainSegment(
  text: string,
  options: EscapeTelegramMarkdownV2Options,
): string {
  if (!text) return text;
  if (!options.preserveStyleMarkers) {
    return escapeTelegramMarkdownV2Plain(text);
  }

  let out = '';
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const marker = text[index] as TelegramStyleMarker;
    if (
      !TELEGRAM_STYLE_MARKERS.has(marker) ||
      isEscapedAt(text, index) ||
      !isValidOpeningMarker(text, index, marker)
    ) {
      index += 1;
      continue;
    }

    let closing = -1;
    for (let i = index + 1; i < text.length; i += 1) {
      if (text[i] !== marker || isEscapedAt(text, i)) continue;
      if (!isValidClosingMarker(text, i, marker)) continue;
      closing = i;
      break;
    }

    if (closing === -1) {
      index += 1;
      continue;
    }

    if (cursor < index) {
      out += escapeTelegramMarkdownV2Plain(text.slice(cursor, index));
    }

    const content = text.slice(index + 1, closing);
    out += `${marker}${escapeTelegramMarkdownV2PlainSegment(content, options)}${marker}`;
    cursor = closing + 1;
    index = cursor;
  }

  if (cursor < text.length) {
    out += escapeTelegramMarkdownV2Plain(text.slice(cursor));
  }

  return out;
}
