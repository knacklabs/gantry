import { describe, expect, it } from 'vitest';

import { normalizeTelegramChatJid } from './telegram.js';

describe('cli telegram helpers', () => {
  it('normalizes valid numeric chat ids', () => {
    expect(normalizeTelegramChatJid('-100123')).toBe('tg:-100123');
    expect(normalizeTelegramChatJid('tg:-100123')).toBe('tg:-100123');
    expect(normalizeTelegramChatJid(' 12345 ')).toBe('tg:12345');
  });

  it('rejects invalid chat ids', () => {
    expect(normalizeTelegramChatJid('')).toBeNull();
    expect(normalizeTelegramChatJid('abc')).toBeNull();
    expect(normalizeTelegramChatJid('tg:abc')).toBeNull();
  });
});
