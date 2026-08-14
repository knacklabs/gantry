import fs from 'fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveChromeExecutablePath } from '@core/shared/chrome-executable.js';

describe('Chrome executable resolution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses Google Chrome and never falls back to Chromium on Linux', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (candidate) => candidate === '/usr/bin/google-chrome-stable',
    );

    expect(resolveChromeExecutablePath('linux')).toBe(
      '/usr/bin/google-chrome-stable',
    );
  });

  it('fails clearly when Google Chrome is unavailable on Linux', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    expect(() => resolveChromeExecutablePath('linux')).toThrow(
      'Google Chrome is required for the managed browser',
    );
  });
});
