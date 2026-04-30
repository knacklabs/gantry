import { describe, expect, it } from 'vitest';

import {
  buildChromeLaunchArgs,
  DEFAULT_CHROME_ARGS,
} from '@core/runtime/browser-config.js';

describe('browser Chrome launch args', () => {
  it('does not disable the sandbox for macOS host launches', () => {
    const args = buildChromeLaunchArgs({
      userDataDir: '/tmp/myclaw-browser',
      port: 9222,
      headless: false,
      platform: 'darwin',
      uid: 501,
    });

    expect(args).not.toContain('--no-sandbox');
    expect(args).not.toContain('--disable-setuid-sandbox');
    expect(args).not.toContain('--headless=new');
  });

  it('keeps the sandbox enabled for non-root Linux host launches', () => {
    const args = buildChromeLaunchArgs({
      userDataDir: '/tmp/myclaw-browser',
      port: 9222,
      platform: 'linux',
      uid: 1000,
    });

    expect(args).not.toContain('--no-sandbox');
    expect(args).not.toContain('--disable-setuid-sandbox');
  });

  it('uses only no-sandbox for Linux root launches', () => {
    const args = buildChromeLaunchArgs({
      userDataDir: '/tmp/myclaw-browser',
      port: 9222,
      platform: 'linux',
      uid: 0,
    });

    expect(args).toContain('--no-sandbox');
    expect(args).not.toContain('--disable-setuid-sandbox');
  });

  it('keeps default shared flags minimal and CDP-bound to loopback', () => {
    expect(DEFAULT_CHROME_ARGS).toContain(
      '--remote-debugging-address=127.0.0.1',
    );
    expect(DEFAULT_CHROME_ARGS).not.toContain('--no-sandbox');
    expect(DEFAULT_CHROME_ARGS).not.toContain('--disable-setuid-sandbox');
  });
});
