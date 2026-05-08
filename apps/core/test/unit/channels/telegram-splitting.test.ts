import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_MESSAGE_MAX_LENGTH,
  TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
  escapeTelegramMarkdownV2,
  splitTelegramDeliveryText,
} from '@core/channels/telegram/channel-shared.js';

function hasUnpairedSurrogate(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = input.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
      continue;
    }
    if (isLow) return true;
  }
  return false;
}

function hasOddTrailingBackslashes(input: string): boolean {
  let count = 0;
  for (let i = input.length - 1; i >= 0 && input[i] === '\\'; i -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

describe('Telegram MarkdownV2 chunk planner', () => {
  it('splits 10k fenced code blocks into independently parseable fenced chunks', () => {
    const code = `${'x'.repeat(10000)}\n`;
    const escaped = escapeTelegramMarkdownV2(`\`\`\`ts\n${code}\`\`\``);
    const chunks = splitTelegramDeliveryText(
      escaped,
      TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      TELEGRAM_MESSAGE_MAX_LENGTH,
    );

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(
        TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      );
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LENGTH);
      expect(chunk.startsWith('```ts\n')).toBe(true);
      expect(chunk.endsWith('```')).toBe(true);
    }

    const restoredCode = chunks
      .map((chunk) => chunk.slice('```ts\n'.length, -3))
      .join('');
    expect(restoredCode).toBe(code);
  });

  it('keeps long Markdown links structurally valid when link labels exceed chunk budget', () => {
    const label = `${'A'.repeat(5000)}🙂`;
    const escaped = escapeTelegramMarkdownV2(
      `[${label}](https://example.com/path_(alpha))`,
    );
    const chunks = splitTelegramDeliveryText(
      escaped,
      TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      TELEGRAM_MESSAGE_MAX_LENGTH,
    );

    expect(chunks.length).toBeGreaterThan(1);
    const restoredLabel = chunks
      .map((chunk) => {
        const separator = chunk.indexOf('](');
        return separator > 1 ? chunk.slice(1, separator) : '';
      })
      .join('');
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(
        TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      );
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LENGTH);
      expect(chunk.startsWith('[')).toBe(true);
      expect(chunk.includes('](https://example.com/path_')).toBe(true);
      expect(chunk.endsWith(')')).toBe(true);
    }
    expect(restoredLabel).toBe(label);
  });

  it.each([
    { marker: '*', label: 'bold' },
    { marker: '_', label: 'italic' },
    { marker: '~', label: 'strike' },
  ])(
    'splits long $label spans into independently parseable chunks',
    ({ marker }) => {
      const body = 'x'.repeat(10000);
      const raw = `${marker}${body}${marker}`;
      const chunks = splitTelegramDeliveryText(
        raw,
        TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
        TELEGRAM_MESSAGE_MAX_LENGTH,
      );

      expect(chunks.length).toBeGreaterThan(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(
          TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
        );
        expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LENGTH);
        expect(chunk.startsWith(marker)).toBe(true);
        expect(chunk.endsWith(marker)).toBe(true);
      }

      const restored = chunks.map((chunk) => chunk.slice(1, -1)).join('');
      expect(restored).toBe(body);
    },
  );

  it('keeps fenced-code chunk endings escape-safe before closing fences', () => {
    const rawCode = `${'a'.repeat(2000)}\\\`${'b'.repeat(2100)}\\\\${'c'.repeat(2200)}`;
    const escaped = escapeTelegramMarkdownV2(`\`\`\`ts\n${rawCode}\`\`\``);
    const chunks = splitTelegramDeliveryText(
      escaped,
      TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      TELEGRAM_MESSAGE_MAX_LENGTH,
    );

    expect(chunks.length).toBeGreaterThan(1);
    const prefix = '```ts\n';
    const restoredEscapedCodeBody = chunks
      .map((chunk, index) => {
        expect(chunk.length).toBeLessThanOrEqual(
          TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
        );
        expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LENGTH);
        expect(chunk.startsWith(prefix)).toBe(true);
        expect(chunk.endsWith('```')).toBe(true);

        const codeBody = chunk.slice(prefix.length, -3);
        if (index < chunks.length - 1) {
          expect(hasOddTrailingBackslashes(codeBody)).toBe(false);
        }
        return codeBody;
      })
      .join('');

    const expectedEscapedCodeBody = escaped.slice(prefix.length, -3);
    expect(restoredEscapedCodeBody).toBe(expectedEscapedCodeBody);
  });

  it('preserves emoji/codepoint safety while chunking', () => {
    const escaped = escapeTelegramMarkdownV2(`start ${'🙂'.repeat(3600)} end`);
    const chunks = splitTelegramDeliveryText(
      escaped,
      TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      TELEGRAM_MESSAGE_MAX_LENGTH,
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(
        TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      );
      expect(hasUnpairedSurrogate(chunk)).toBe(false);
    }
  });

  it('escapes paired literal markdown markers in plain text', () => {
    expect(escapeTelegramMarkdownV2('snake_case_with_more')).toBe(
      'snake\\_case\\_with\\_more',
    );
    expect(escapeTelegramMarkdownV2('2 * 3 * 4')).toBe('2 \\* 3 \\* 4');
    expect(escapeTelegramMarkdownV2('~literal~')).toBe('\\~literal\\~');
  });

  it('keeps paired literal marker escaping stable when chunked', () => {
    const raw = `${'a'.repeat(3600)} snake_case_with_more 2 * 3 * 4 ~literal~ ${'b'.repeat(3600)}`;
    const escaped = escapeTelegramMarkdownV2(raw);
    const chunks = splitTelegramDeliveryText(
      escaped,
      TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      TELEGRAM_MESSAGE_MAX_LENGTH,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(escaped);
    expect(escaped).toContain('snake\\_case\\_with\\_more');
    expect(escaped).toContain('2 \\* 3 \\* 4');
    expect(escaped).toContain('\\~literal\\~');
  });

  it('handles escape growth and still respects soft/hard limits', () => {
    const raw = '[]()_'.repeat(1200);
    const escaped = escapeTelegramMarkdownV2(raw);
    const chunks = splitTelegramDeliveryText(
      escaped,
      TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      TELEGRAM_MESSAGE_MAX_LENGTH,
    );

    expect(escaped.length).toBeGreaterThan(raw.length);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(
        TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      );
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LENGTH);
    }
    expect(chunks.join('')).toBe(escaped);
  });
});
