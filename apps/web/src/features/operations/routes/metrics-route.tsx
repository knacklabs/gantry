import { useQuery } from '@tanstack/react-query';
import { Activity, CircleOff, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import {
  metricsQuery,
  type UiMetricRange,
  type UiMetricUsage,
  uiApiErrorMessage,
} from '../../../lib/ui-api';
import { MetricTile } from '../../../ui/compositions/metric-tile';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs } from '../../../ui/compositions/route-tabs';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '../../../ui/primitives/alert';
import { Button } from '../../../ui/primitives/button';

const ranges: UiMetricRange[] = ['24h', '7d', '30d'];
const views = [
  { label: 'Overview', value: 'overview' },
  { label: 'Usage', value: 'usage' },
  { label: 'Runtime', value: 'runtime' },
] as const;
type MetricsView = (typeof views)[number]['value'];

const number = new Intl.NumberFormat();
const money = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const utcTimestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

export function MetricsRoute() {
  const [range, setRange] = useState<UiMetricRange>('24h');
  const [view, setView] = useState<MetricsView>('overview');
  const query = useQuery(metricsQuery(range));

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Metrics"
        description="Bounded workload, usage, and run performance reported by this Gantry deployment."
        action={
          <Button
            disabled={query.isFetching}
            variant="secondary"
            onClick={() => void query.refetch({ cancelRefetch: false })}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {query.isFetching ? 'Refreshing' : 'Refresh'}
          </Button>
        }
      />

      <div className="grid gap-4">
        <div className="grid gap-3">
          <RouteTabs
            label="Metrics view"
            tabs={views}
            value={view}
            onValueChange={setView}
          />
          <div aria-label="Metrics range" className="flex gap-1" role="group">
            {ranges.map((item) => (
              <Button
                aria-pressed={item === range}
                className="min-w-12"
                key={item}
                size="sm"
                variant={item === range ? 'secondary' : 'ghost'}
                onClick={() => setRange(item)}
              >
                {item}
              </Button>
            ))}
          </div>
        </div>

        {query.isPending ? (
          <PageState
            description={`Reading the ${range} metrics projection from Gantry.`}
            icon={<Activity aria-hidden="true" />}
            kind="loading"
            title="Loading metrics"
          />
        ) : null}

        {query.isError && !query.data ? (
          <PageState
            action={<Button onClick={() => void query.refetch()}>Retry</Button>}
            description={uiApiErrorMessage(query.error)}
            icon={<CircleOff aria-hidden="true" />}
            kind="offline"
            title="Metrics are unavailable"
          />
        ) : null}

        {query.data ? (
          <>
            {query.isError ? (
              <Alert className="border-status-attention/50 bg-status-attention-soft">
                <RefreshCw aria-hidden="true" />
                <AlertTitle>Showing the last successful metrics</AlertTitle>
                <AlertDescription>
                  {uiApiErrorMessage(query.error)} Refresh to try again.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-text-secondary uppercase">
              <span>
                {formatTimestamp(query.data.from)} –{' '}
                {formatTimestamp(query.data.to)} UTC
              </span>
              <span>
                Updated {new Date(query.dataUpdatedAt).toLocaleTimeString()}
              </span>
            </div>

            {view === 'overview' ? (
              <Overview usage={query.data.usage.totals} />
            ) : null}
            {view === 'usage' ? (
              <Usage
                bucket={query.data.bucket}
                buckets={query.data.usage.buckets}
                models={query.data.usage.models}
                totals={query.data.usage.totals}
              />
            ) : null}
            {view === 'runtime' ? <Runtime runs={query.data.runs} /> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Overview({ usage }: { usage: UiMetricUsage }) {
  const cacheTokens =
    usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined
      ? undefined
      : usage.cacheReadTokens + usage.cacheWriteTokens;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricTile
        detail="Recorded model requests"
        label="Requests"
        value={formatNumber(usage.requestCount)}
      />
      <MetricTile
        detail={`${formatNumber(usage.inputTokens)} input · ${formatNumber(usage.outputTokens)} output`}
        label="Tokens"
        value={formatNumber(usage.inputTokens + usage.outputTokens)}
      />
      <MetricTile
        detail="Read and write tokens"
        label="Cache tokens"
        value={formatOptionalNumber(cacheTokens)}
      />
      <MetricTile
        detail="Recorded by the provider"
        label="Recorded cost"
        value={formatCost(usage.estimatedCostUsd)}
      />
    </div>
  );
}

function Usage({
  bucket,
  buckets,
  models,
  totals,
}: {
  bucket: 'hour' | 'day';
  buckets: Array<UiMetricUsage & { start: string }>;
  models: Array<UiMetricUsage & { model: string }>;
  totals: UiMetricUsage;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          detail="Prompt tokens"
          label="Input tokens"
          value={formatNumber(totals.inputTokens)}
        />
        <MetricTile
          detail="Generated tokens"
          label="Output tokens"
          value={formatNumber(totals.outputTokens)}
        />
        <MetricTile
          detail="Served from cache"
          label="Cache reads"
          value={formatOptionalNumber(totals.cacheReadTokens)}
        />
        <MetricTile
          detail="Written to cache"
          label="Cache writes"
          value={formatOptionalNumber(totals.cacheWriteTokens)}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <MetricBars
          buckets={buckets}
          description={`${bucket === 'hour' ? 'Hourly' : 'Daily'} UTC input and output tokens`}
          title="Token flow"
          value={(item) => item.inputTokens + item.outputTokens}
          valueLabel={(item) =>
            `${formatNumber(item.inputTokens)} input, ${formatNumber(item.outputTokens)} output tokens`
          }
        />
        <MetricBars
          buckets={buckets}
          description={`${bucket === 'hour' ? 'Hourly' : 'Daily'} UTC model requests`}
          title="Request volume"
          value={(item) => item.requestCount}
          valueLabel={(item) => `${formatNumber(item.requestCount)} requests`}
        />
      </div>
      <Panel title="Model mix" description="Up to five models plus Other">
        {models.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
              <thead className="border-b border-border bg-surface-muted text-text-secondary">
                <tr>
                  <th className="h-10 px-4 font-medium">Model</th>
                  <th className="h-10 px-4 text-right font-medium">Requests</th>
                  <th className="h-10 px-4 text-right font-medium">Input</th>
                  <th className="h-10 px-4 text-right font-medium">Output</th>
                  <th className="h-10 px-4 text-right font-medium">Cache</th>
                  <th className="h-10 px-4 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr
                    className="border-b border-border last:border-0"
                    key={model.model}
                  >
                    <td className="h-12 px-4 font-mono text-xs font-semibold text-text">
                      {model.model}
                    </td>
                    <td className="h-12 px-4 text-right">
                      {formatNumber(model.requestCount)}
                    </td>
                    <td className="h-12 px-4 text-right">
                      {formatNumber(model.inputTokens)}
                    </td>
                    <td className="h-12 px-4 text-right">
                      {formatNumber(model.outputTokens)}
                    </td>
                    <td className="h-12 px-4 text-right">
                      {formatCache(model)}
                    </td>
                    <td className="h-12 px-4 text-right">
                      {formatCost(model.estimatedCostUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m-0 p-4 text-sm text-text-secondary">
            No model usage was recorded for this range.
          </p>
        )}
      </Panel>
    </div>
  );
}

function MetricBars({
  buckets,
  description,
  title,
  value,
  valueLabel,
}: {
  buckets: Array<UiMetricUsage & { start: string }>;
  description: string;
  title: string;
  value: (bucket: UiMetricUsage) => number;
  valueLabel: (bucket: UiMetricUsage) => string;
}) {
  const maximum = Math.max(0, ...buckets.map(value));
  return (
    <Panel title={title} description={description}>
      {buckets.length && maximum ? (
        <div className="overflow-x-auto">
          <figure className="m-0 min-w-[420px] p-4">
            <div className="flex h-44 items-end gap-1 overflow-hidden border-b border-border px-1">
              {buckets.map((item) => (
                <div
                  aria-label={`${formatBucket(item.start)}: ${valueLabel(item)}`}
                  className="min-w-1 flex-1 rounded-t-sm bg-status-success"
                  key={item.start}
                  role="img"
                  style={{
                    height: `${Math.max(2, (value(item) / maximum) * 100)}%`,
                  }}
                  title={`${formatBucket(item.start)} · ${valueLabel(item)}`}
                />
              ))}
            </div>
            <figcaption className="mt-2 flex justify-between gap-4 font-mono text-[10px] text-text-secondary">
              <span>{formatBucket(buckets[0]!.start)}</span>
              <span>{formatBucket(buckets.at(-1)!.start)}</span>
            </figcaption>
          </figure>
        </div>
      ) : (
        <p className="m-0 p-4 text-sm text-text-secondary">
          No {title.toLowerCase()} was recorded for this range.
        </p>
      )}
    </Panel>
  );
}

function Runtime({
  runs,
}: {
  runs: {
    total: number;
    statuses: Array<{ status: string; count: number }>;
    p95DurationMs?: number;
  };
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.6fr)]">
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricTile
          detail="Completed, failed, and canceled"
          label="Agent runs"
          value={formatNumber(runs.total)}
        />
        <MetricTile
          detail="95th percentile"
          label="End-to-end agent run duration"
          value={formatDuration(runs.p95DurationMs)}
        />
      </div>
      <Panel title="Run status" description="Terminal runs by outcome">
        {runs.statuses.length ? (
          <dl className="m-0 divide-y divide-border px-4">
            {runs.statuses.map(({ status, count }) => (
              <div
                className="grid min-h-12 grid-cols-[1fr_auto] items-center gap-4 py-2 text-[13px]"
                key={status}
              >
                <dt className="capitalize text-text-secondary">{status}</dt>
                <dd className="m-0 font-mono text-xs font-semibold text-text">
                  {formatNumber(count)}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="m-0 p-4 text-sm text-text-secondary">
            No terminal runs were recorded for this range.
          </p>
        )}
      </Panel>
    </div>
  );
}

function formatNumber(value: number) {
  return number.format(value);
}

function formatOptionalNumber(value: number | undefined) {
  return value === undefined ? 'Unavailable' : formatNumber(value);
}

function formatCache(usage: UiMetricUsage) {
  return usage.cacheReadTokens === undefined ||
    usage.cacheWriteTokens === undefined
    ? 'Unavailable'
    : formatNumber(usage.cacheReadTokens + usage.cacheWriteTokens);
}

function formatCost(value: number | undefined) {
  return value === undefined ? 'Unavailable' : money.format(value);
}

function formatDuration(value: number | undefined) {
  if (value === undefined) return 'Unavailable';
  return value < 1_000
    ? `${formatNumber(value)} ms`
    : `${(value / 1_000).toFixed(1)} s`;
}

function formatTimestamp(value: string) {
  return utcTimestamp.format(new Date(value));
}

function formatBucket(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    timeZone: 'UTC',
  });
}
