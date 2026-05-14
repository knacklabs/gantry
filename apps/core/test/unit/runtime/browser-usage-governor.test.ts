import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginBrowserUsage,
  browserUsageBucketCountForTests,
  finishBrowserUsage,
  normalizeBrowserSiteFromUrl,
  rememberBrowserUsageSite,
  resetBrowserUsageGovernorForTests,
} from '@core/runtime/browser-usage-governor.js';

const usageSettings = {
  enabled: true,
  mode: 'enforce' as const,
  windowMs: 1_000,
  maxActionsPerWindow: 1,
  maxConcurrentPerSite: 1,
  overrides: {},
};

describe('browser usage governor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T00:00:00.000Z'));
    resetBrowserUsageGovernorForTests();
  });

  afterEach(() => {
    resetBrowserUsageGovernorForTests();
    vi.useRealTimers();
  });

  it('normalizes sites with public suffix awareness', () => {
    expect(normalizeBrowserSiteFromUrl('https://app.example.co.uk/path')).toBe(
      'example.co.uk',
    );
    expect(normalizeBrowserSiteFromUrl('https://app.example.com/path')).toBe(
      'example.com',
    );
  });

  it('does not normalize non-web browser URLs as sites', () => {
    expect(normalizeBrowserSiteFromUrl('about:blank')).toBeUndefined();
    expect(normalizeBrowserSiteFromUrl('chrome://settings/')).toBeUndefined();
    expect(
      normalizeBrowserSiteFromUrl('file:///tmp/example.txt'),
    ).toBeUndefined();
  });

  it('does not fall back to remembered site for explicit unnormalizable URLs', () => {
    rememberBrowserUsageSite({
      action: 'navigate',
      payload: { url: 'https://app.example.com/path' },
      profileName: 'profile-a',
      ok: true,
    });

    const activeInternalPage = beginBrowserUsage({
      action: 'click',
      payload: {},
      profileName: 'profile-a',
      settings: usageSettings,
      activeUrl: 'chrome://settings/',
    });
    const navigateInternalPage = beginBrowserUsage({
      action: 'navigate',
      payload: { url: 'about:blank' },
      profileName: 'profile-a',
      settings: usageSettings,
    });

    expect(activeInternalPage.normalizedSite).toBe('unknown');
    expect(navigateInternalPage.normalizedSite).toBe('unknown');
  });

  it('does not meter status launch or close actions', () => {
    const first = beginBrowserUsage({
      action: 'navigate',
      payload: { url: 'https://app.example.com/path' },
      profileName: 'profile-a',
      settings: usageSettings,
    });
    const status = beginBrowserUsage({
      action: 'status',
      payload: {},
      profileName: 'profile-a',
      settings: usageSettings,
    });
    const close = beginBrowserUsage({
      action: 'close',
      payload: {},
      profileName: 'profile-a',
      settings: usageSettings,
    });

    expect(first.allowed).toBe(true);
    expect(status.allowed).toBe(true);
    expect(close.allowed).toBe(true);
    expect(browserUsageBucketCountForTests()).toBe(1);
  });

  it('prunes expired inactive buckets opportunistically', () => {
    const first = beginBrowserUsage({
      action: 'navigate',
      payload: { url: 'https://one.example.net/path' },
      profileName: 'profile-a',
      settings: usageSettings,
    });
    finishBrowserUsage(first);
    vi.setSystemTime(new Date('2026-05-11T00:00:02.000Z'));

    beginBrowserUsage({
      action: 'navigate',
      payload: { url: 'https://two.example.com/path' },
      profileName: 'profile-a',
      settings: usageSettings,
    });

    expect(browserUsageBucketCountForTests()).toBe(1);
  });
});
