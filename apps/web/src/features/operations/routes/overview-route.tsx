import { useQuery } from '@tanstack/react-query';
import { Bot, CircleOff, RefreshCw, Server } from 'lucide-react';

import {
  agentsQuery,
  connectionQuery,
  uiApiErrorMessage,
} from '../../../lib/ui-api';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '../../../ui/primitives/alert';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';

export function OverviewRoute() {
  const connection = useQuery(connectionQuery);
  const agents = useQuery(agentsQuery);
  const refreshing = connection.isFetching || agents.isFetching;

  function refresh() {
    void Promise.all([
      connection.refetch({ cancelRefetch: false }),
      agents.refetch({ cancelRefetch: false }),
    ]);
  }

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Overview"
        description="Live state reported by this Gantry deployment."
        action={
          <Button disabled={refreshing} variant="secondary" onClick={refresh}>
            <RefreshCw size={16} aria-hidden="true" />
            {refreshing ? 'Refreshing' : 'Refresh all'}
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Deployment"
          description="Control API reachability and process role"
          action={
            connection.data ? (
              <StatusBadge status={connection.data.status} />
            ) : null
          }
        >
          <PanelContent
            data={connection.data}
            error={connection.error}
            isError={connection.isError}
            isPending={connection.isPending}
            loadingTitle="Loading deployment state"
            unavailableTitle="Deployment is unavailable"
            onRetry={() => void connection.refetch({ cancelRefetch: false })}
          >
            {(data) => {
              const features = Object.entries(data.features)
                .filter(([, enabled]) => enabled)
                .map(([feature]) => feature);
              return (
                <dl className="m-0 divide-y divide-border px-4">
                  <Detail label="Process role" value={data.processRole} />
                  <Detail
                    label="Available features"
                    value={features.length ? features.join(', ') : 'None'}
                  />
                </dl>
              );
            }}
          </PanelContent>
        </Panel>

        <Panel
          title="Agents"
          description="Agent directory from the current deployment"
          action={
            agents.data ? (
              <Badge variant="neutral">{agents.data.agents.length} total</Badge>
            ) : null
          }
        >
          <PanelContent
            data={agents.data}
            error={agents.error}
            isError={agents.isError}
            isPending={agents.isPending}
            loadingTitle="Loading agents"
            unavailableTitle="Agent data is unavailable"
            onRetry={() => void agents.refetch({ cancelRefetch: false })}
          >
            {(data) =>
              data.agents.length ? (
                <div className="divide-y divide-border">
                  {data.agents.slice(0, 5).map((agent) => (
                    <div
                      className="flex min-h-14 items-center justify-between gap-4 px-4 py-3"
                      key={agent.id}
                    >
                      <span className="truncate text-[13px] font-semibold text-text">
                        {agent.name}
                      </span>
                      <StatusBadge status={agent.status} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4">
                  <PageState
                    description="This deployment has not reported any agents."
                    icon={<Bot aria-hidden="true" />}
                    kind="empty"
                    title="No agents found"
                  />
                </div>
              )
            }
          </PanelContent>
        </Panel>
      </div>
    </div>
  );
}

function PanelContent<T>({
  children,
  data,
  error,
  isError,
  isPending,
  loadingTitle,
  unavailableTitle,
  onRetry,
}: {
  children: (data: T) => React.ReactNode;
  data: T | undefined;
  error: unknown;
  isError: boolean;
  isPending: boolean;
  loadingTitle: string;
  unavailableTitle: string;
  onRetry: () => void;
}) {
  if (isPending) {
    return (
      <div className="p-4">
        <PageState
          description="Reading the latest state from Gantry."
          icon={<Server aria-hidden="true" />}
          kind="loading"
          title={loadingTitle}
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-4">
        <PageState
          action={<Button onClick={onRetry}>Retry</Button>}
          description={uiApiErrorMessage(error)}
          icon={<CircleOff aria-hidden="true" />}
          kind="offline"
          title={unavailableTitle}
        />
      </div>
    );
  }

  return (
    <>
      {isError ? (
        <Alert className="rounded-none border-x-0 border-t-0 border-status-attention/50 bg-status-attention-soft">
          <RefreshCw aria-hidden="true" />
          <AlertTitle>Showing the last successful value</AlertTitle>
          <AlertDescription>{uiApiErrorMessage(error)}</AlertDescription>
        </Alert>
      ) : null}
      {children(data)}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-h-14 grid-cols-[140px_minmax(0,1fr)] items-center gap-4 py-3 text-[13px]">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="m-0 truncate font-mono text-xs font-semibold text-text">
        {value}
      </dd>
    </div>
  );
}
