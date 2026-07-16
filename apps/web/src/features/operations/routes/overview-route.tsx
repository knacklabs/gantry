import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDotDashed,
} from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { MetricTile } from '../../../ui/compositions/metric-tile';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  conversations,
  overviewMetrics,
  setupBlockers,
} from '../operations-preview';
import {
  diagnosticPreviewQuery,
  interactionPreviewQuery,
  providerPreviewQuery,
} from '../operations-queries';

export function OverviewRoute() {
  const { data: providers } = useQuery(providerPreviewQuery);
  const { data: interactions } = useQuery(interactionPreviewQuery);
  const { data: diagnostics } = useQuery(diagnosticPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const healthyChecks = diagnostics.filter(
    (check) => check.status === 'passing',
  ).length;

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Overview"
        description="Readiness, activity, and the items that need owner attention."
      />

      <section
        aria-label="Operational metrics"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        {overviewMetrics.map((metric) => (
          <MetricTile key={metric.label} {...metric} />
        ))}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,.85fr)]">
        <Panel
          title="Setup blockers"
          description="Resolve these before expecting every route to work."
          action={
            <Badge tone="attention">{setupBlockers.length} blockers</Badge>
          }
        >
          <div className="divide-y divide-border">
            {setupBlockers.map((blocker) => (
              <div
                className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center"
                key={blocker.id}
              >
                <div className="flex min-w-0 flex-1 gap-3">
                  <span className="mt-0.5 text-danger">
                    <AlertTriangle size={17} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="m-0 text-[13px] font-semibold text-text">
                      {blocker.title}
                    </p>
                    <p className="mt-1 mb-0 text-xs leading-5 text-text-secondary">
                      {blocker.detail}
                    </p>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => requestConnection(blocker.action)}
                >
                  {blocker.action}
                </Button>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="System health"
          description="Latest checks represented by this preview snapshot."
          action={
            <Badge
              tone={
                healthyChecks === diagnostics.length ? 'success' : 'attention'
              }
            >
              {healthyChecks}/{diagnostics.length} passing
            </Badge>
          }
        >
          <div className="divide-y divide-border">
            <HealthRow
              label="Runtime and storage"
              detail="Core process and projection are current"
              healthy
            />
            <HealthRow
              label="Provider accounts"
              detail={`${providers.filter((item) => item.status === 'ready').length} ready · ${providers.length} total`}
              healthy={false}
            />
            <HealthRow
              label="Waiting interactions"
              detail={`${interactions.length} decisions need review`}
              healthy={false}
            />
          </div>
          <Link
            className="flex min-h-11 items-center justify-between border-t border-border px-4 text-[13px] font-semibold text-text no-underline hover:bg-surface-muted"
            search={{ status: 'all' }}
            to="/diagnostics"
          >
            View diagnostics
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </Panel>
      </div>

      <Panel
        title="Recent conversations"
        description="The channels and direct conversations with the latest activity."
        action={
          <Link
            className="text-xs font-semibold text-text no-underline hover:underline"
            search={{
              q: '',
              status: 'all',
              page: 1,
              sort: 'activity',
              desc: false,
            }}
            to="/conversations"
          >
            View all
          </Link>
        }
      >
        <div className="divide-y divide-border">
          {conversations.slice(0, 4).map((conversation) => (
            <Link
              className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 text-text no-underline hover:bg-surface-muted"
              key={conversation.id}
              params={{ conversationId: conversation.id }}
              to="/conversations/$conversationId"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold">
                  {conversation.name}
                </span>
                <span className="mt-1 block truncate text-xs text-text-secondary">
                  {conversation.provider} · {conversation.agent}
                </span>
              </span>
              <span className="text-xs text-text-muted">
                {conversation.activity}
              </span>
            </Link>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function HealthRow({
  label,
  detail,
  healthy,
}: {
  label: string;
  detail: string;
  healthy: boolean;
}) {
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <span
        className={healthy ? 'text-status-success' : 'text-status-attention'}
      >
        {healthy ? (
          <CheckCircle2 size={17} aria-hidden="true" />
        ) : (
          <CircleDotDashed size={17} aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-text">
          {label}
        </span>
        <span className="mt-0.5 block text-xs text-text-secondary">
          {detail}
        </span>
      </span>
    </div>
  );
}
