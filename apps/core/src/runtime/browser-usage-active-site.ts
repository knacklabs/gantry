import type { BrowserBackendAction } from '../shared/browser-backend-actions.js';

import { normalizeBrowserSiteFromUrl } from '../shared/browser-site.js';
import { nowMs } from '../shared/time/datetime.js';
import { ensureBrowserReady } from './browser-capability.js';
import type { BrowserSessionStatus } from './browser-capability-types.js';
import type { BrowserUsageSettings } from './browser-usage-governor.js';

const UNMETERED_BROWSER_USAGE_ACTIONS = new Set<BrowserBackendAction>([
  'status',
  'open',
  'close',
]);

type BrowserUsageBackend = (input: {
  toolName: BrowserBackendAction;
  arguments: Record<string, unknown>;
  session: BrowserSessionStatus;
  fileAccessRoot: string;
  timeoutMs?: number;
}) => Promise<unknown>;

export function browserUsagePayloadUrl(
  action: BrowserBackendAction,
  payload: Record<string, unknown>,
): string | undefined {
  if (
    action !== 'navigate' &&
    !(action === 'tabs' && payload.action === 'new')
  ) {
    return undefined;
  }
  return typeof payload.url === 'string' && payload.url.trim()
    ? payload.url
    : undefined;
}

function browserUsageHasEnforceRule(
  settings: BrowserUsageSettings | undefined,
): boolean {
  if (!settings?.enabled) return false;
  return (
    settings.mode === 'enforce' ||
    Object.values(settings.overrides).some(
      (override) => override.mode === 'enforce',
    )
  );
}

function shouldResolveActiveBrowserUrlForUsage(input: {
  action: BrowserBackendAction;
  payload: Record<string, unknown>;
  settings: BrowserUsageSettings | undefined;
}): boolean {
  if (!input.settings?.enabled) return false;
  if (UNMETERED_BROWSER_USAGE_ACTIONS.has(input.action)) return false;
  if (browserUsagePayloadUrl(input.action, input.payload)) return false;
  return true;
}

function browserIpcDeadline(input: {
  timeoutMs?: number;
  deadlineAtMs?: number;
}): { deadlineAtMs?: number } {
  if (
    typeof input.deadlineAtMs === 'number' &&
    Number.isFinite(input.deadlineAtMs)
  ) {
    return { deadlineAtMs: Math.trunc(input.deadlineAtMs) };
  }
  if (
    typeof input.timeoutMs !== 'number' ||
    !Number.isFinite(input.timeoutMs)
  ) {
    return {};
  }
  return { deadlineAtMs: nowMs() + Math.max(1, Math.trunc(input.timeoutMs)) };
}

function browserIpcRemainingMs(deadline: {
  deadlineAtMs?: number;
}): number | undefined {
  if (deadline.deadlineAtMs === undefined) return undefined;
  const remainingMs = Math.trunc(deadline.deadlineAtMs - nowMs());
  if (remainingMs <= 0) {
    throw new Error('Browser IPC deadline exceeded');
  }
  return remainingMs;
}

function browserToolResultIsError(result: unknown): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { isError?: unknown }).isError === true
  );
}

function tabUrlFromRow(tab: unknown): string | undefined {
  if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return undefined;
  const url = (tab as Record<string, unknown>).url;
  return typeof url === 'string' && url ? url : undefined;
}

function tabIndexFromRow(tab: unknown): number | undefined {
  if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return undefined;
  const index = (tab as Record<string, unknown>).index;
  return typeof index === 'number' &&
    Number.isFinite(index) &&
    Number.isInteger(index)
    ? index
    : undefined;
}

function activeTabUrlFromResult(
  result: unknown,
  action: BrowserBackendAction,
  payload: Record<string, unknown>,
): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }
  const structuredContent = (result as Record<string, unknown>)
    .structuredContent;
  if (
    !structuredContent ||
    typeof structuredContent !== 'object' ||
    Array.isArray(structuredContent)
  ) {
    return undefined;
  }
  const tabs = (structuredContent as Record<string, unknown>).tabs;
  if (!Array.isArray(tabs) || tabs.length === 0) return undefined;
  if (
    action === 'tabs' &&
    (payload.action === 'select' || payload.action === 'close') &&
    typeof payload.index === 'number'
  ) {
    return tabUrlFromRow(
      tabs.find((tab) => tabIndexFromRow(tab) === payload.index),
    );
  }
  const current = tabs.find((tab) => {
    if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return false;
    return (tab as Record<string, unknown>).current === true;
  });
  if (current) return tabUrlFromRow(current);
  return tabs.length === 1 ? tabUrlFromRow(tabs[0]) : undefined;
}

export async function resolveActiveBrowserUrlForUsage(input: {
  action: BrowserBackendAction;
  payload: Record<string, unknown>;
  browserIpcAuthorized?: boolean;
  profileName: string;
  settings: BrowserUsageSettings | undefined;
  timeoutMs?: number;
  deadlineAtMs?: number;
  sourceAgentFolder: string;
  callBrowserTool?: BrowserUsageBackend;
  fileAccessRoot: string;
}): Promise<string | undefined> {
  if (!shouldResolveActiveBrowserUrlForUsage(input)) return undefined;
  if (!input.browserIpcAuthorized) return undefined;
  const deadline = browserIpcDeadline(input);
  const requireVerifiedSite = browserUsageHasEnforceRule(input.settings);
  try {
    browserIpcRemainingMs(deadline);
    const session = await ensureBrowserReady({
      profileName: input.profileName,
      deadlineAtMs: deadline.deadlineAtMs,
    });
    if (!session.port || !input.callBrowserTool) {
      if (requireVerifiedSite) {
        throw new Error('Browser backend is unavailable for active tab lookup');
      }
      return undefined;
    }
    const tabList = await input.callBrowserTool({
      toolName: 'tabs',
      arguments: { action: 'list' },
      session,
      fileAccessRoot: input.fileAccessRoot,
      timeoutMs: browserIpcRemainingMs(deadline),
    });
    const activeUrl = browserToolResultIsError(tabList)
      ? undefined
      : activeTabUrlFromResult(tabList, input.action, input.payload);
    if (!activeUrl) {
      if (requireVerifiedSite) {
        throw new Error('Browser backend did not expose a current tab URL');
      }
      return undefined;
    }
    if (!normalizeBrowserSiteFromUrl(activeUrl)) {
      if (requireVerifiedSite) {
        throw new Error(
          'Browser backend current tab URL is not a normalizable site',
        );
      }
      return activeUrl;
    }
    return activeUrl;
  } catch (err) {
    if (requireVerifiedSite) {
      throw new Error(
        `Browser usage policy could not verify the active page site before ${input.action}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
    console.warn('Browser usage audit could not resolve active page URL', {
      err,
      sourceAgentFolder: input.sourceAgentFolder,
      action: input.action,
    });
    return undefined;
  }
}
