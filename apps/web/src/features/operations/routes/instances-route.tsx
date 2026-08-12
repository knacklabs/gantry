import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleOff, RefreshCw, Server } from 'lucide-react';

import { instancesQuery, uiApiErrorMessage } from '../../../lib/ui-api';
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

export function InstancesRoute() {
  const query = useQuery(instancesQuery);

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Instances"
        description="Serving process and deduplicated registered workers."
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
          description="Reading the current process inventory."
          icon={<Server aria-hidden="true" />}
          kind="loading"
          title="Loading instances"
        />
      ) : null}

      {query.isError && !query.data ? (
        <PageState
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
          description={uiApiErrorMessage(query.error)}
          icon={<CircleOff aria-hidden="true" />}
          kind="offline"
          title="Instances are unavailable"
        />
      ) : null}

      {query.data ? (
        <>
          {query.isError ? (
            <Alert className="border-status-attention/50 bg-status-attention-soft">
              <RefreshCw aria-hidden="true" />
              <AlertTitle>Showing the last successful inventory</AlertTitle>
              <AlertDescription>
                {uiApiErrorMessage(query.error)} Refresh to try again.
              </AlertDescription>
            </Alert>
          ) : null}

          {query.data.instances.length === 0 ? (
            <PageState
              description="No serving process or registered worker was reported."
              icon={<Server aria-hidden="true" />}
              kind="empty"
              title="No instances found"
            />
          ) : (
            <Panel
              title="Runtime inventory"
              description={`${query.data.instances.length} deduplicated instances`}
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
                  <thead className="border-b border-border bg-surface-muted text-text-secondary">
                    <tr>
                      <th className="h-10 px-4 font-medium">Instance</th>
                      <th className="h-10 px-4 font-medium">Role</th>
                      <th className="h-10 px-4 font-medium">State</th>
                      <th className="h-10 px-4 font-medium">Heartbeat</th>
                      <th className="h-10 px-4 font-medium">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.instances.map((instance) => (
                      <tr
                        className="border-b border-border last:border-0 hover:bg-surface-muted"
                        key={instance.id}
                      >
                        <td className="h-14 px-4">
                          <Link
                            className="font-mono text-xs font-semibold text-text no-underline hover:underline"
                            params={{ instanceId: instance.id }}
                            to="/instances/$instanceId"
                          >
                            {instance.id}
                          </Link>
                        </td>
                        <td className="h-14 px-4 text-text-secondary">
                          {instance.role}
                        </td>
                        <td className="h-14 px-4">
                          <StatusBadge status={displayStatus(instance)} />
                        </td>
                        <td className="h-14 px-4">
                          <StatusBadge status={instance.heartbeat.status} />
                        </td>
                        <td className="h-14 px-4 text-text-secondary">
                          <Timestamp value={instance.lastSeenAt} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      ) : null}
    </div>
  );
}

function displayStatus(instance: {
  status: string;
  heartbeat: { status: string };
  readiness: { status: string } | null;
}) {
  if (instance.heartbeat.status === 'stale') return 'stale';
  if (instance.readiness?.status === 'degraded') return 'degraded';
  return instance.status;
}

function Timestamp({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value}>{date.toLocaleString()}</time>;
}
