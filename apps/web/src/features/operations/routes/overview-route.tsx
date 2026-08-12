import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleOff, RefreshCw, Server } from 'lucide-react';

import { overviewQuery, uiApiErrorMessage } from '../../../lib/ui-api';
import { MetricTile } from '../../../ui/compositions/metric-tile';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '../../../ui/primitives/alert';
import { Button } from '../../../ui/primitives/button';

export function OverviewRoute() {
  const query = useQuery(overviewQuery);

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Overview"
        description="Health, capacity, and inventory reported by this Gantry deployment."
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
          description="Reading the deployment inventory from Gantry."
          icon={<Server aria-hidden="true" />}
          kind="loading"
          title="Loading deployment overview"
        />
      ) : null}

      {query.isError && !query.data ? (
        <PageState
          action={
            <Button
              onClick={() => void query.refetch({ cancelRefetch: false })}
            >
              Retry
            </Button>
          }
          description={uiApiErrorMessage(query.error)}
          icon={<CircleOff aria-hidden="true" />}
          kind="offline"
          title="Deployment overview is unavailable"
        />
      ) : null}

      {query.data ? (
        <>
          {query.isError || query.data.unavailable.length ? (
            <Alert className="border-status-attention/50 bg-status-attention-soft">
              <RefreshCw aria-hidden="true" />
              <AlertTitle>
                {query.isError
                  ? 'Showing the last successful overview'
                  : 'Some overview data is unavailable'}
              </AlertTitle>
              <AlertDescription>
                {query.isError
                  ? uiApiErrorMessage(query.error)
                  : `Unavailable: ${query.data.unavailable.join(', ')}.`}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile
              label="Deployment"
              value={
                query.data.deployment ? (
                  <StatusBadge status={query.data.deployment.status} />
                ) : (
                  'Unavailable'
                )
              }
              detail={
                query.data.deployment
                  ? `${query.data.deployment.role} process`
                  : 'Runtime summary could not be read'
              }
            />
            <MetricTile
              label="Instances"
              value={query.data.instanceCounts?.instances ?? 'Unavailable'}
              detail={
                query.data.instanceCounts
                  ? `${query.data.instanceCounts.liveWorkers} live · ${query.data.instanceCounts.jobWorkers} job`
                  : 'Runtime summary could not be read'
              }
            />
            <MetricTile
              label="Agents"
              value={query.data.agentCounts?.total ?? 'Unavailable'}
              detail={
                query.data.agentCounts
                  ? `${query.data.agentCounts.active} active · ${query.data.agentCounts.disabled} disabled`
                  : 'Agent directory could not be read'
              }
            />
            <MetricTile
              label="Live capacity"
              value={query.data.deployment?.capacity.liveLimit ?? 'Unavailable'}
              detail={
                query.data.deployment
                  ? `Job limit ${query.data.deployment.capacity.jobLimit ?? 'unbounded'}`
                  : 'Runtime summary could not be read'
              }
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel
              title="Attention"
              description="Current health signals that may need investigation"
              action={<StatusBadge status={query.data.attention.status} />}
            >
              <Link
                className="flex min-h-14 items-center justify-between gap-4 px-4 py-3 text-[13px] font-semibold text-text no-underline hover:bg-surface-muted"
                to={query.data.attention.to}
              >
                <span>{query.data.attention.label}</span>
                <span aria-hidden="true">→</span>
              </Link>
            </Panel>

            <Panel
              title="Readiness"
              description="Serving-process checks"
              action={
                query.data.deployment ? (
                  <StatusBadge
                    status={query.data.deployment.readiness.status}
                  />
                ) : null
              }
            >
              {query.data.deployment ? (
                <dl className="m-0 divide-y divide-border px-4">
                  {Object.entries(query.data.deployment.readiness.checks).map(
                    ([name, value]) => (
                      <div
                        className="grid min-h-12 grid-cols-[1fr_auto] items-center gap-4 py-2 text-[13px]"
                        key={name}
                      >
                        <dt className="capitalize text-text-secondary">
                          {name.replaceAll(/([A-Z])/g, ' $1')}
                        </dt>
                        <dd className="m-0">
                          <StatusBadge status={String(value)} />
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
              ) : (
                <p className="p-4 text-sm text-text-secondary">
                  Readiness data is unavailable.
                </p>
              )}
            </Panel>
          </div>
        </>
      ) : null}
    </div>
  );
}
