import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, CircleOff, RefreshCw, Server } from 'lucide-react';

import { instanceQuery, uiApiErrorMessage } from '../../../lib/ui-api';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';

export function InstanceDetailRoute() {
  const { instanceId } = useParams({ from: '/instances/$instanceId' });
  const query = useQuery(instanceQuery(instanceId));

  if (query.isPending) {
    return (
      <PageState
        description="Reading this instance from Gantry."
        icon={<Server aria-hidden="true" />}
        kind="loading"
        title="Loading instance"
      />
    );
  }

  if (!query.data) {
    return (
      <PageState
        action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        description={uiApiErrorMessage(query.error)}
        icon={<CircleOff aria-hidden="true" />}
        kind="offline"
        title="Instance is unavailable"
      />
    );
  }

  const instance = query.data.instance;
  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        to="/instances"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Instances
      </Link>
      <PageHeader
        eyebrow="Runtime instance"
        title={instance.id}
        description={`${instance.role} · Started ${new Date(instance.startedAt).toLocaleString()}`}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge
              status={instance.readiness?.status ?? instance.status}
            />
            <Button
              disabled={query.isFetching}
              variant="secondary"
              onClick={() => void query.refetch()}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {query.isFetching ? 'Refreshing' : 'Refresh'}
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Signals" description="Current heartbeat and readiness">
          <dl className="m-0 divide-y divide-border px-4">
            <Detail label="Process status" value={instance.status} />
            <Detail label="Heartbeat" value={instance.heartbeat.status} />
            <Detail
              label="Readiness"
              value={instance.readiness?.status ?? 'Not reported'}
            />
            <Detail
              label="Last seen"
              value={new Date(instance.lastSeenAt).toLocaleString()}
            />
          </dl>
        </Panel>
        <Panel title="Capacity" description="Configured concurrency limits">
          <dl className="m-0 divide-y divide-border px-4">
            <Detail
              label="Live limit"
              value={String(instance.capacity?.liveLimit ?? 'Not reported')}
            />
            <Detail
              label="Job limit"
              value={String(instance.capacity?.jobLimit ?? 'Not reported')}
            />
          </dl>
        </Panel>
      </div>

      <Panel
        title="Capabilities"
        description="Roles advertised by this instance"
      >
        <div className="flex flex-wrap gap-2 p-4">
          {instance.capabilities.length ? (
            instance.capabilities.map((capability) => (
              <Badge key={capability}>{capability}</Badge>
            ))
          ) : (
            <span className="text-sm text-text-secondary">
              No capabilities reported.
            </span>
          )}
        </div>
      </Panel>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-h-14 grid-cols-[140px_minmax(0,1fr)] items-center gap-4 py-3 text-[13px]">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="m-0 truncate font-semibold text-text">{value}</dd>
    </div>
  );
}
