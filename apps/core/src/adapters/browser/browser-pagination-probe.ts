import type { Page } from 'playwright-core';

import { nowMs, toIso } from '../../shared/time/datetime.js';

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_SETTLE_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_PROBE_TIMEOUT_MS = 60_000;
const MAX_ROW_IDENTITIES = 10_000;
const MAX_IDENTITY_CHARS = 512;
const MAX_OBSERVED_REQUESTS = 200;

interface ProbeRows {
  count: number;
  uniqueCount: number;
  identities: string[];
}

interface ProbeSnapshot {
  scroll: { x: number; y: number };
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  rows: ProbeRows;
  observedTotal?: { text: string; value?: number };
}

interface RawProbeSnapshot extends Omit<ProbeSnapshot, 'observedTotal'> {
  invalidIdentityCount: number;
  totalFound?: boolean;
  observedTotalText?: string;
}

interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  status?: number;
}

export interface BrowserPaginationProbeEvidence {
  schemaVersion: 'browser.pagination_probe@1';
  capturedAt: string;
  pageUrl: string;
  selectors: { row?: string; identity?: string; total?: string };
  outcome: 'growth' | 'no_growth' | 'blocked';
  before: ProbeSnapshot | null;
  after: ProbeSnapshot | null;
  observedRequests: Array<{ method: string; url: string; status?: number }>;
  elapsedMs: number;
  blockReason?: string;
}

export async function runBrowserPaginationProbe(input: {
  page: Page;
  args: Record<string, unknown>;
  network: NetworkEntry[];
}): Promise<BrowserPaginationProbeEvidence> {
  const startedAt = nowMs();
  const capturedAt = toIso(startedAt);
  const row = stringValue(input.args.row_selector);
  const identity = stringValue(input.args.identity_selector);
  const total = stringValue(input.args.total_selector);
  const selectors = {
    ...(row ? { row } : {}),
    ...(identity ? { identity } : {}),
    ...(total ? { total } : {}),
  };
  const base = {
    schemaVersion: 'browser.pagination_probe@1' as const,
    capturedAt,
    pageUrl: redactUrl(input.page.url()),
    selectors,
    observedRequests: [],
  };
  if (!row) return blockedEvidence(base, startedAt, 'row_selector is required');
  if (!identity) {
    return blockedEvidence(base, startedAt, 'identity_selector is required');
  }

  const probeTimeoutMs = boundedInteger(
    input.args.probe_timeout_ms,
    DEFAULT_PROBE_TIMEOUT_MS,
    100,
    MAX_PROBE_TIMEOUT_MS,
  );
  const settleMs = boundedInteger(
    input.args.settle_ms,
    DEFAULT_SETTLE_MS,
    50,
    Math.min(5_000, probeTimeoutMs),
  );
  const pollIntervalMs = boundedInteger(
    input.args.poll_interval_ms,
    DEFAULT_POLL_INTERVAL_MS,
    25,
    Math.min(1_000, settleMs),
  );

  let beforeRaw: RawProbeSnapshot;
  try {
    beforeRaw = await captureProbeSnapshot(input.page, {
      row,
      identity,
      total,
    });
  } catch (error) {
    return blockedEvidence(base, startedAt, selectorError(error));
  }
  const beforeFailure = invalidSnapshotReason(beforeRaw, total !== undefined);
  if (beforeFailure) {
    return blockedEvidence(base, startedAt, beforeFailure);
  }
  const before = normalizeSnapshot(beforeRaw);
  const priorRequestIds = new Set(input.network.map((entry) => entry.id));

  try {
    await input.page.evaluate(() => {
      const scope = globalThis as any;
      const root = scope.document.documentElement;
      const body = scope.document.body;
      const height = Math.max(
        root?.scrollHeight ?? 0,
        root?.offsetHeight ?? 0,
        body?.scrollHeight ?? 0,
        body?.offsetHeight ?? 0,
      );
      scope.scrollTo({ top: height, left: 0, behavior: 'auto' });
    });
  } catch (error) {
    return blockedEvidence(
      base,
      startedAt,
      `scroll failed: ${errorMessage(error)}`,
      before,
    );
  }

  let after = before;
  let fingerprint = snapshotFingerprint(before);
  let stableSince = nowMs();
  while (nowMs() - startedAt < probeTimeoutMs) {
    await input.page.waitForTimeout(pollIntervalMs);
    let raw: RawProbeSnapshot;
    try {
      raw = await captureProbeSnapshot(input.page, { row, identity, total });
    } catch (error) {
      return blockedEvidence(
        withRequests(base, input.network, priorRequestIds),
        startedAt,
        selectorError(error),
        before,
        after,
      );
    }
    const invalid = invalidSnapshotReason(raw, total !== undefined);
    if (invalid) {
      return blockedEvidence(
        withRequests(base, input.network, priorRequestIds),
        startedAt,
        invalid,
        before,
        normalizeSnapshot(raw),
      );
    }
    after = normalizeSnapshot(raw);
    const nextFingerprint = snapshotFingerprint(after);
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint;
      stableSince = nowMs();
    }
    if (nowMs() - stableSince < settleMs) continue;
    if (after.rows.identities.length < before.rows.identities.length) {
      return blockedEvidence(
        withRequests(base, input.network, priorRequestIds),
        startedAt,
        'row identity set shrank while settling',
        before,
        after,
      );
    }
    const beforeIds = new Set(before.rows.identities);
    const outcome = after.rows.identities.some((value) => !beforeIds.has(value))
      ? 'growth'
      : 'no_growth';
    return {
      ...withRequests(base, input.network, priorRequestIds),
      outcome,
      before,
      after,
      elapsedMs: nowMs() - startedAt,
    };
  }

  return blockedEvidence(
    withRequests(base, input.network, priorRequestIds),
    startedAt,
    'row identities did not settle before probe_timeout_ms',
    before,
    after,
  );
}

async function captureProbeSnapshot(
  page: Page,
  selectors: { row: string; identity: string; total?: string },
): Promise<RawProbeSnapshot> {
  return await page.evaluate(
    ({ row, identity, total, maxRows, maxIdentityChars }) => {
      const scope = globalThis as any;
      const root = scope.document.documentElement;
      const body = scope.document.body;
      const rowElements = Array.from(
        scope.document.querySelectorAll(row),
      ) as any[];
      const identities: string[] = [];
      let invalidIdentityCount = 0;
      for (const rowElement of rowElements.slice(0, maxRows + 1)) {
        const identityElement =
          identity === ':scope'
            ? rowElement
            : rowElement.querySelector(identity);
        const value = (identityElement?.textContent ?? '')
          .replace(/\s+/gu, ' ')
          .trim();
        if (!value || value.length > maxIdentityChars) {
          invalidIdentityCount += 1;
          continue;
        }
        identities.push(value);
      }
      const totalElement = total ? scope.document.querySelector(total) : null;
      return {
        scroll: { x: scope.scrollX, y: scope.scrollY },
        viewport: {
          width: scope.innerWidth,
          height: scope.innerHeight,
        },
        document: {
          width: Math.max(
            root?.scrollWidth ?? 0,
            root?.offsetWidth ?? 0,
            body?.scrollWidth ?? 0,
            body?.offsetWidth ?? 0,
          ),
          height: Math.max(
            root?.scrollHeight ?? 0,
            root?.offsetHeight ?? 0,
            body?.scrollHeight ?? 0,
            body?.offsetHeight ?? 0,
          ),
        },
        rows: {
          count: rowElements.length,
          uniqueCount: new Set(identities).size,
          identities,
        },
        invalidIdentityCount,
        ...(total
          ? {
              totalFound: totalElement !== null,
              observedTotalText: (totalElement?.textContent ?? '')
                .replace(/\s+/gu, ' ')
                .trim(),
            }
          : {}),
      };
    },
    {
      ...selectors,
      maxRows: MAX_ROW_IDENTITIES,
      maxIdentityChars: MAX_IDENTITY_CHARS,
    },
  );
}

function invalidSnapshotReason(
  snapshot: RawProbeSnapshot,
  totalRequired: boolean,
): string | undefined {
  if (snapshot.rows.count === 0) return 'row_selector matched no rows';
  if (snapshot.rows.count > MAX_ROW_IDENTITIES) {
    return `row_selector matched more than ${MAX_ROW_IDENTITIES} rows`;
  }
  if (snapshot.invalidIdentityCount > 0) {
    return 'identity_selector must resolve to one non-empty identity of at most 512 characters per row';
  }
  if (snapshot.rows.uniqueCount !== snapshot.rows.count) {
    return 'identity_selector produced duplicate row identities';
  }
  if (totalRequired && snapshot.totalFound !== true) {
    return 'total_selector matched no element';
  }
  return undefined;
}

function normalizeSnapshot(snapshot: RawProbeSnapshot): ProbeSnapshot {
  return {
    scroll: snapshot.scroll,
    viewport: snapshot.viewport,
    document: snapshot.document,
    rows: snapshot.rows,
    ...(snapshot.observedTotalText !== undefined
      ? {
          observedTotal: {
            text: snapshot.observedTotalText,
            ...parsedTotal(snapshot.observedTotalText),
          },
        }
      : {}),
  };
}

function parsedTotal(text: string): { value?: number } {
  const matches = text.match(/\d[\d,._]*/gu);
  const match = matches?.at(-1);
  if (!match) return {};
  const digits = match.replace(/\D/gu, '');
  const value = Number(digits);
  return Number.isSafeInteger(value) ? { value } : {};
}

function snapshotFingerprint(snapshot: ProbeSnapshot): string {
  return JSON.stringify(snapshot);
}

function withRequests<T extends { observedRequests: unknown[] }>(
  base: T,
  network: NetworkEntry[],
  priorRequestIds: Set<string>,
): Omit<T, 'observedRequests'> & {
  observedRequests: Array<{ method: string; url: string; status?: number }>;
} {
  return {
    ...base,
    observedRequests: network
      .filter((entry) => !priorRequestIds.has(entry.id))
      .slice(-MAX_OBSERVED_REQUESTS)
      .map((entry) => ({
        method: entry.method,
        url: redactUrl(entry.url),
        ...(typeof entry.status === 'number' ? { status: entry.status } : {}),
      })),
  };
}

function blockedEvidence(
  base: Omit<
    BrowserPaginationProbeEvidence,
    'outcome' | 'before' | 'after' | 'elapsedMs' | 'blockReason'
  >,
  startedAt: number,
  blockReason: string,
  before: ProbeSnapshot | null = null,
  after: ProbeSnapshot | null = null,
): BrowserPaginationProbeEvidence {
  return {
    ...base,
    outcome: 'blocked',
    before,
    after,
    elapsedMs: nowMs() - startedAt,
    blockReason,
  };
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, '[REDACTED]');
    }
    url.hash = '';
    return url.toString();
  } catch {
    return '[REDACTED_INVALID_URL]';
  }
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const normalized =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function selectorError(error: unknown): string {
  return `selector evaluation failed: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
