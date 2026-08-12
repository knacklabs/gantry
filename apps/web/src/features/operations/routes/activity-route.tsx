import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Activity, CircleOff, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  activityQuery,
  type UiActivityRun,
  uiApiErrorMessage,
} from '../../../lib/ui-api';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '../../../ui/primitives/alert';
import { Button } from '../../../ui/primitives/button';

const filters = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Completed', value: 'completed' },
  { label: 'Needs attention', value: 'attention' },
] as const;
type ActivityFilter = (typeof filters)[number]['value'];

export function ActivityRoute() {
  const query = useQuery(activityQuery);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const runs = query.data?.runs ?? [];
  const tabs = useMemo(
    () =>
      filters.map((item) => ({
        ...item,
        count: runs.filter((run) => matchesFilter(run, item.value)).length,
      })),
    [runs],
  );
  const visibleRuns = runs.filter((run) => matchesFilter(run, filter));

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Live activity"
        description="Recent agent runs and their current execution state."
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

      {query.isPending ? (
        <PageState
          description="Reading the most recent agent runs from Gantry."
          icon={<Activity aria-hidden="true" />}
          kind="loading"
          title="Loading activity"
        />
      ) : null}

      {query.isError && !query.data ? (
        <PageState
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
          description={uiApiErrorMessage(query.error)}
          icon={<CircleOff aria-hidden="true" />}
          kind="offline"
          title="Activity is unavailable"
        />
      ) : null}

      {query.data ? (
        <>
          {query.isError ? (
            <Alert className="border-status-attention/50 bg-status-attention-soft">
              <RefreshCw aria-hidden="true" />
              <AlertTitle>Showing the last successful activity</AlertTitle>
              <AlertDescription>
                {uiApiErrorMessage(query.error)} Refresh to try again.
              </AlertDescription>
            </Alert>
          ) : null}

          {runs.length === 0 ? (
            <PageState
              description="New agent runs will appear here when this Gantry deployment starts work."
              icon={<Activity aria-hidden="true" />}
              kind="empty"
              title="No agent activity yet"
            />
          ) : (
            <div className="grid gap-3">
              <RouteTabs
                label="Activity filter"
                tabs={tabs}
                value={filter}
                onValueChange={setFilter}
              />
              <Panel
                title="Recent runs"
                description={`${visibleRuns.length} of ${runs.length} runs shown`}
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[780px] border-collapse text-left text-[13px]">
                    <thead className="border-b border-border bg-surface-muted text-text-secondary">
                      <tr>
                        <th className="h-10 px-4 font-medium">Run</th>
                        <th className="h-10 px-4 font-medium">Agent</th>
                        <th className="h-10 px-4 font-medium">Cause</th>
                        <th className="h-10 px-4 font-medium">Status</th>
                        <th className="h-10 px-4 font-medium">Started</th>
                        <th className="h-10 px-4 font-medium">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRuns.length ? (
                        visibleRuns.map((run) => (
                          <tr
                            className="border-b border-border last:border-0 hover:bg-surface-muted"
                            key={run.id}
                          >
                            <td className="h-14 px-4">
                              <Link
                                className="grid min-h-9 content-center text-text no-underline hover:underline"
                                params={{ runId: run.id }}
                                to="/activity/$runId"
                              >
                                <span className="font-mono text-xs font-semibold">
                                  {run.id}
                                </span>
                                {(run.errorSummary ?? run.resultSummary) ? (
                                  <span className="max-w-80 truncate text-xs font-normal text-text-secondary">
                                    {run.errorSummary ?? run.resultSummary}
                                  </span>
                                ) : null}
                              </Link>
                            </td>
                            <td className="h-14 px-4 font-mono text-xs text-text-secondary">
                              {run.agentId}
                            </td>
                            <td className="h-14 px-4 text-text-secondary">
                              {formatLabel(run.cause)}
                            </td>
                            <td className="h-14 px-4">
                              <StatusBadge status={run.status} />
                            </td>
                            <td className="h-14 px-4 text-text-secondary">
                              <Timestamp
                                value={run.startedAt ?? run.createdAt}
                              />
                            </td>
                            <td className="h-14 px-4 text-text-secondary">
                              {formatDuration(run.durationMs)}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td
                            className="h-28 px-4 text-center text-text-secondary"
                            colSpan={6}
                          >
                            No runs match this filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function matchesFilter(run: UiActivityRun, filter: ActivityFilter) {
  if (filter === 'all') return true;
  if (filter === 'active')
    return run.status === 'queued' || run.status === 'running';
  if (filter === 'completed') return run.status === 'completed';
  return ['failed', 'canceled', 'timeout'].includes(run.status);
}

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

function formatDuration(durationMs: number | null) {
  if (durationMs === null) return 'In progress';
  if (durationMs < 1_000) return `${durationMs} ms`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatLabel(value: string) {
  return value
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}
