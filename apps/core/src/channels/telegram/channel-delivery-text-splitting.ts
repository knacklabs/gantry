type TelegramMarkdownSegment =
  | { kind: 'plain'; text: string }
  | { kind: 'fenced_code'; text: string }
  | { kind: 'inline_code'; text: string }
  | { kind: 'link'; text: string };

type TelegramStyleMarker = '*' | '_' | '~';

type TelegramPlainSegmentToken =
  | { kind: 'plain'; text: string }
  | { kind: 'styled'; marker: TelegramStyleMarker; content: string };

const TELEGRAM_MARKDOWN_V2_PROTECTED_PATTERN =
  /```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]+\]\((?:\\.|[^\\\n)])+\)/g;
const TELEGRAM_MARKDOWN_V2_LINK_PATTERN = /^\[([\s\S]+)]\(([\s\S]+)\)$/;
const TELEGRAM_STYLE_MARKERS = new Set<TelegramStyleMarker>(['*', '_', '~']);

export function splitTelegramTextByCodeUnits(
  text: string,
  maxCodeUnits: number,
): string[] {
  if (!text) return [];
  if (maxCodeUnits <= 0) return [text];
  if (text.length <= maxCodeUnits) return [text];

  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkLength = 0;
  for (const codePoint of text) {
    const codePointLength = codePoint.length;
    if (chunkLength > 0 && chunkLength + codePointLength > maxCodeUnits) {
      chunks.push(text.slice(chunkStart, chunkStart + chunkLength));
      chunkStart += chunkLength;
      chunkLength = 0;
    }
    chunkLength += codePointLength;
  }
  if (chunkStart < text.length) {
    chunks.push(text.slice(chunkStart));
  }
  return chunks;
}

function previousCodePointStart(text: string, endExclusive: number): number {
  const previousIndex = endExclusive - 1;
  if (previousIndex <= 0) return previousIndex;
  const current = text.charCodeAt(previousIndex);
  const before = text.charCodeAt(previousIndex - 1);
  const isLowSurrogate = current >= 0xdc00 && current <= 0xdfff;
  const isHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  return isLowSurrogate && isHighSurrogate ? previousIndex - 1 : previousIndex;
}

function nextCodePointEnd(
  text: string,
  startInclusive: number,
  maxCodeUnits: number,
): number {
  let endExclusive = startInclusive;
  let used = 0;
  for (let cursor = startInclusive; cursor < text.length;) {
    const value = text.codePointAt(cursor);
    if (value === undefined) break;
    const codePointLength = value > 0xffff ? 2 : 1;
    if (used > 0 && used + codePointLength > maxCodeUnits) break;
    used += codePointLength;
    cursor += codePointLength;
    endExclusive = cursor;
  }
  return endExclusive;
}

function hasOddTrailingBackslashes(text: string): boolean {
  let trailingBackslashes = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    trailingBackslashes += 1;
  }
  return trailingBackslashes % 2 === 1;
}

function splitTelegramTextByCodeUnitsEscapeAware(
  text: string,
  maxCodeUnits: number,
): string[] {
  if (!text) return [];
  if (maxCodeUnits <= 0) return [text];
  if (text.length <= maxCodeUnits) return [text];

  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    const candidateEnd = nextCodePointEnd(text, start, maxCodeUnits);
    if (candidateEnd <= start) {
      parts.push(text.slice(start));
      break;
    }
    let end = candidateEnd;
    if (candidateEnd < text.length) {
      while (end > start && hasOddTrailingBackslashes(text.slice(start, end))) {
        end = previousCodePointStart(text, end);
      }
      if (end === start) end = candidateEnd;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function isEscapedAt(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function tokenizeTelegramStyledPlainText(
  text: string,
): TelegramPlainSegmentToken[] {
  if (!text) return [];

  const tokens: TelegramPlainSegmentToken[] = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const marker = text[index] as TelegramStyleMarker;
    if (!TELEGRAM_STYLE_MARKERS.has(marker) || isEscapedAt(text, index)) {
      index += 1;
      continue;
    }

    let closing = -1;
    for (let i = index + 1; i < text.length; i += 1) {
      if (text[i] !== marker || isEscapedAt(text, i)) continue;
      closing = i;
      break;
    }
    if (closing === -1) {
      index += 1;
      continue;
    }

    if (index > cursor) {
      tokens.push({ kind: 'plain', text: text.slice(cursor, index) });
    }
    tokens.push({
      kind: 'styled',
      marker,
      content: text.slice(index + 1, closing),
    });
    cursor = closing + 1;
    index = cursor;
  }

  if (cursor < text.length) {
    tokens.push({ kind: 'plain', text: text.slice(cursor) });
  }

  return tokens.length > 0 ? tokens : [{ kind: 'plain', text }];
}

function tokenizeTelegramMarkdownV2(text: string): TelegramMarkdownSegment[] {
  const segments: TelegramMarkdownSegment[] = [];
  const pattern = new RegExp(
    TELEGRAM_MARKDOWN_V2_PROTECTED_PATTERN.source,
    'g',
  );
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        kind: 'plain',
        text: text.slice(lastIndex, match.index),
      });
    }
    const token = match[0];
    if (token.startsWith('```')) {
      segments.push({ kind: 'fenced_code', text: token });
    } else if (token.startsWith('`')) {
      segments.push({ kind: 'inline_code', text: token });
    } else {
      segments.push({ kind: 'link', text: token });
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'plain', text: text.slice(lastIndex) });
  }
  return segments;
}

function splitTelegramFencedCodeSegment(
  segment: string,
  maxCodeUnits: number,
): string[] {
  if (segment.length <= maxCodeUnits) return [segment];
  const body = segment.slice(3, -3);
  const firstNewline = body.indexOf('\n');
  const hasLanguage = firstNewline !== -1;
  const language = hasLanguage ? body.slice(0, firstNewline) : '';
  const code = hasLanguage ? body.slice(firstNewline + 1) : body;
  const prefix = hasLanguage ? `\`\`\`${language}\n` : '```';
  const suffix = '```';
  const availableCodeUnits = maxCodeUnits - prefix.length - suffix.length;
  if (availableCodeUnits <= 0) {
    return splitTelegramTextByCodeUnits(segment, maxCodeUnits);
  }
  const parts = splitTelegramTextByCodeUnitsEscapeAware(
    code,
    availableCodeUnits,
  );
  if (parts.length === 0) return [`${prefix}${suffix}`];
  return parts.map((part) => `${prefix}${part}${suffix}`);
}

function splitTelegramInlineCodeSegment(
  segment: string,
  maxCodeUnits: number,
): string[] {
  if (segment.length <= maxCodeUnits) return [segment];
  const code = segment.slice(1, -1);
  const availableCodeUnits = maxCodeUnits - 2;
  if (availableCodeUnits <= 0) {
    return splitTelegramTextByCodeUnits(segment, maxCodeUnits);
  }
  const parts = splitTelegramTextByCodeUnits(code, availableCodeUnits);
  return parts.map((part) => `\`${part}\``);
}

function splitTelegramLinkSegment(
  segment: string,
  maxCodeUnits: number,
): string[] {
  if (segment.length <= maxCodeUnits) return [segment];
  const match = TELEGRAM_MARKDOWN_V2_LINK_PATTERN.exec(segment);
  if (!match) return splitTelegramTextByCodeUnits(segment, maxCodeUnits);
  const label = match[1];
  const url = match[2];
  const labelBudget = maxCodeUnits - url.length - 4;
  if (labelBudget <= 0) {
    return splitTelegramTextByCodeUnits(segment, maxCodeUnits);
  }
  const labelParts = splitTelegramTextByCodeUnits(label, labelBudget);
  return labelParts.map((part) => `[${part}](${url})`);
}

function splitTelegramPlainSegment(
  text: string,
  maxCodeUnits: number,
): string[] {
  if (text.length <= maxCodeUnits) return [text];
  const out: string[] = [];
  const tokens = tokenizeTelegramStyledPlainText(text);
  for (const token of tokens) {
    if (token.kind === 'plain') {
      out.push(...splitTelegramTextByCodeUnits(token.text, maxCodeUnits));
      continue;
    }

    const wrapped = `${token.marker}${token.content}${token.marker}`;
    if (wrapped.length <= maxCodeUnits) {
      out.push(wrapped);
      continue;
    }
    const contentBudget = maxCodeUnits - 2;
    if (contentBudget <= 0) {
      out.push(...splitTelegramTextByCodeUnits(wrapped, maxCodeUnits));
      continue;
    }
    const contentParts = splitTelegramTextByCodeUnitsEscapeAware(
      token.content,
      contentBudget,
    );
    if (contentParts.length === 0) {
      out.push(wrapped);
      continue;
    }
    out.push(
      ...contentParts.map((part) => `${token.marker}${part}${token.marker}`),
    );
  }
  return out;
}

function splitTelegramMarkdownSegment(
  segment: TelegramMarkdownSegment,
  maxCodeUnits: number,
): string[] {
  if (segment.text.length <= maxCodeUnits) return [segment.text];
  switch (segment.kind) {
    case 'plain':
      return splitTelegramPlainSegment(segment.text, maxCodeUnits);
    case 'fenced_code':
      return splitTelegramFencedCodeSegment(segment.text, maxCodeUnits);
    case 'inline_code':
      return splitTelegramInlineCodeSegment(segment.text, maxCodeUnits);
    case 'link':
      return splitTelegramLinkSegment(segment.text, maxCodeUnits);
  }
  const exhaustiveCheck: never = segment;
  throw new Error(`Unhandled Telegram markdown segment: ${exhaustiveCheck}`);
}

function planTelegramMarkdownV2Chunks(
  text: string,
  maxCodeUnits: number,
): string[] {
  if (!text) return [];
  if (text.length <= maxCodeUnits) return [text];

  const chunks: string[] = [];
  let current = '';
  const segments = tokenizeTelegramMarkdownV2(text);
  for (const segment of segments) {
    const parts = splitTelegramMarkdownSegment(segment, maxCodeUnits);
    for (const part of parts) {
      if (!part) continue;
      if (part.length > maxCodeUnits) {
        const overflow = splitTelegramTextByCodeUnits(part, maxCodeUnits);
        for (const piece of overflow) {
          if (!piece) continue;
          if (current.length + piece.length > maxCodeUnits && current) {
            chunks.push(current);
            current = '';
          }
          if (piece.length > maxCodeUnits) {
            chunks.push(piece);
            continue;
          }
          current += piece;
        }
        continue;
      }
      if (current.length + part.length > maxCodeUnits && current) {
        chunks.push(current);
        current = '';
      }
      current += part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitTelegramDeliveryTextWithLimits(
  text: string,
  softCodeUnitBudget: number,
  hardCodeUnitLimit: number,
): string[] {
  if (!text) return [];
  const planned = planTelegramMarkdownV2Chunks(
    text,
    Math.max(1, Math.min(softCodeUnitBudget, hardCodeUnitLimit)),
  );
  const out: string[] = [];
  for (const part of planned) {
    if (part.length <= hardCodeUnitLimit) {
      out.push(part);
      continue;
    }
    out.push(...splitTelegramTextByCodeUnits(part, hardCodeUnitLimit));
  }
  return out;
}
