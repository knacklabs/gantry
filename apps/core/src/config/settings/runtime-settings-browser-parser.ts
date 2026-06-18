import {
  browserSiteKeyDetails,
  normalizeBrowserSiteKey,
} from '../../shared/browser-site.js';
import {
  DEFAULT_BROWSER_USAGE_ENABLED,
  DEFAULT_BROWSER_USAGE_MAX_ACTIONS_PER_WINDOW,
  DEFAULT_BROWSER_USAGE_MAX_CONCURRENT_PER_SITE,
  DEFAULT_BROWSER_USAGE_MODE,
  DEFAULT_BROWSER_USAGE_WINDOW_MS,
} from './runtime-settings-defaults.js';
import {
  parseBooleanValue,
  parsePositiveIntegerValue,
  parseStringValue,
} from './runtime-settings-parse-primitives.js';
import type {
  RuntimeBrowserSettings,
  RuntimeBrowserUsagePolicyMode,
} from './runtime-settings-types.js';

function parseOptionalPositiveIntegerValue(
  raw: unknown,
  pathPrefix: string,
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${pathPrefix} must be a positive integer`);
  }
  return raw;
}

function parseBrowserUsageMode(
  raw: unknown,
  pathPrefix: string,
  fallback: RuntimeBrowserUsagePolicyMode,
): RuntimeBrowserUsagePolicyMode {
  const value = parseStringValue(raw, pathPrefix, fallback);
  if (value === 'audit' || value === 'enforce') return value;
  throw new Error(`${pathPrefix} must be one of audit, enforce`);
}

function normalizeBrowserUsageOverrideKey(key: string, pathPrefix: string) {
  const trimmed = key.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed) throw new Error(`${pathPrefix} must be a non-empty site key`);
  if (/[/:@?#\\]/.test(trimmed)) {
    throw new Error(
      `${pathPrefix} must be a hostname-style site key without scheme or path`,
    );
  }
  if (
    trimmed === 'localhost' ||
    /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(trimmed)
  ) {
    const details = browserSiteKeyDetails(trimmed);
    const siteKey = normalizeBrowserSiteKey(trimmed);
    if (!details || !siteKey || details.isPublicSuffixOnly) {
      throw new Error(
        `${pathPrefix} must identify a registrable site, localhost, or IP address`,
      );
    }
    return siteKey;
  }
  throw new Error(
    `${pathPrefix} must be a hostname-style site key without scheme or path`,
  );
}

export function parseBrowserSettings(raw: unknown): RuntimeBrowserSettings {
  const defaults: RuntimeBrowserSettings = {
    usage: {
      enabled: DEFAULT_BROWSER_USAGE_ENABLED,
      mode: DEFAULT_BROWSER_USAGE_MODE,
      windowMs: DEFAULT_BROWSER_USAGE_WINDOW_MS,
      maxActionsPerWindow: DEFAULT_BROWSER_USAGE_MAX_ACTIONS_PER_WINDOW,
      maxConcurrentPerSite: DEFAULT_BROWSER_USAGE_MAX_CONCURRENT_PER_SITE,
      overrides: {},
    },
  };
  if (raw === undefined) return defaults;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('browser must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'usage') {
      throw new Error(
        `browser.${key} is not supported. Configure browser.usage.*.`,
      );
    }
  }
  const usageRaw = map.usage;
  if (
    usageRaw !== undefined &&
    (typeof usageRaw !== 'object' ||
      usageRaw === null ||
      Array.isArray(usageRaw))
  ) {
    throw new Error('browser.usage must be a mapping');
  }
  const usage = (usageRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(usage)) {
    if (
      key !== 'enabled' &&
      key !== 'mode' &&
      key !== 'window_ms' &&
      key !== 'max_actions_per_window' &&
      key !== 'max_concurrent_per_site' &&
      key !== 'overrides'
    ) {
      throw new Error(
        `browser.usage.${key} is not supported. Configure enabled, mode, window_ms, max_actions_per_window, max_concurrent_per_site, or overrides.`,
      );
    }
  }
  return {
    usage: {
      enabled: parseBooleanValue(
        usage.enabled,
        'browser.usage.enabled',
        defaults.usage.enabled,
      ),
      mode: parseBrowserUsageMode(
        usage.mode,
        'browser.usage.mode',
        defaults.usage.mode,
      ),
      windowMs: parsePositiveIntegerValue(
        usage.window_ms,
        'browser.usage.window_ms',
        defaults.usage.windowMs,
      ),
      maxActionsPerWindow: parsePositiveIntegerValue(
        usage.max_actions_per_window,
        'browser.usage.max_actions_per_window',
        defaults.usage.maxActionsPerWindow,
      ),
      maxConcurrentPerSite: parsePositiveIntegerValue(
        usage.max_concurrent_per_site,
        'browser.usage.max_concurrent_per_site',
        defaults.usage.maxConcurrentPerSite,
      ),
      overrides: parseBrowserUsageOverrides(
        usage.overrides,
        defaults.usage.mode,
      ),
    },
  };
}

function parseBrowserUsageOverrides(
  raw: unknown,
  defaultMode: RuntimeBrowserUsagePolicyMode,
): RuntimeBrowserSettings['usage']['overrides'] {
  const overridesRaw = raw ?? {};
  if (
    typeof overridesRaw !== 'object' ||
    overridesRaw === null ||
    Array.isArray(overridesRaw)
  ) {
    throw new Error('browser.usage.overrides must be a mapping');
  }
  const overrides: RuntimeBrowserSettings['usage']['overrides'] = {};
  for (const [siteKey, overrideRaw] of Object.entries(
    overridesRaw as Record<string, unknown>,
  )) {
    const site = normalizeBrowserUsageOverrideKey(
      siteKey,
      `browser.usage.overrides.${siteKey}`,
    );
    if (overrides[site]) {
      throw new Error(
        `browser.usage.overrides.${siteKey} normalizes to duplicate site key ${site}`,
      );
    }
    overrides[site] = parseBrowserUsageOverride(
      siteKey,
      overrideRaw,
      defaultMode,
    );
  }
  return overrides;
}

function parseBrowserUsageOverride(
  siteKey: string,
  raw: unknown,
  defaultMode: RuntimeBrowserUsagePolicyMode,
): RuntimeBrowserSettings['usage']['overrides'][string] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`browser.usage.overrides.${siteKey} must be a mapping`);
  }
  const override = raw as Record<string, unknown>;
  for (const key of Object.keys(override)) {
    if (
      key !== 'mode' &&
      key !== 'window_ms' &&
      key !== 'max_actions_per_window' &&
      key !== 'max_concurrent_per_site'
    ) {
      throw new Error(
        `browser.usage.overrides.${siteKey}.${key} is not supported. Configure mode, window_ms, max_actions_per_window, or max_concurrent_per_site.`,
      );
    }
  }
  return {
    ...(override.mode !== undefined
      ? {
          mode: parseBrowserUsageMode(
            override.mode,
            `browser.usage.overrides.${siteKey}.mode`,
            defaultMode,
          ),
        }
      : {}),
    ...(override.window_ms !== undefined
      ? {
          windowMs: parseOptionalPositiveIntegerValue(
            override.window_ms,
            `browser.usage.overrides.${siteKey}.window_ms`,
          ),
        }
      : {}),
    ...(override.max_actions_per_window !== undefined
      ? {
          maxActionsPerWindow: parseOptionalPositiveIntegerValue(
            override.max_actions_per_window,
            `browser.usage.overrides.${siteKey}.max_actions_per_window`,
          ),
        }
      : {}),
    ...(override.max_concurrent_per_site !== undefined
      ? {
          maxConcurrentPerSite: parseOptionalPositiveIntegerValue(
            override.max_concurrent_per_site,
            `browser.usage.overrides.${siteKey}.max_concurrent_per_site`,
          ),
        }
      : {}),
  };
}
