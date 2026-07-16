import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ShieldAlert } from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { MetricTile } from '../../../ui/compositions/metric-tile';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  externalSystemPreviewQuery,
  workflowRunPreviewQuery,
} from '../workflows-queries';

export function ExternalSystemsRoute() {
  const { data: systems } = useQuery(externalSystemPreviewQuery);
  const { data: runs } = useQuery(workflowRunPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const waitingRuns = runs.filter((run) => run.status === 'waiting');

  return (
    <div className="mx-auto grid w-full max-w-[1080px] gap-6">
      <PageHeader
        eyebrow="Workflows"
        title="External systems"
        description="Readiness and pending external steps represented by workflow previews."
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile
          label="Systems"
          value={String(systems.length)}
          detail="represented integrations"
        />
        <MetricTile
          label="Ready"
          value={String(
            systems.filter((system) => system.status === 'ready').length,
          )}
          detail="preview readiness"
        />
        <MetricTile
          label="Pending steps"
          value={String(waitingRuns.length)}
          detail="waiting workflows"
        />
      </div>
      <Panel
        title="System readiness"
        description="No credentials or raw provider payloads are shown."
      >
        <div className="divide-y divide-border">
          {systems.map((system) => (
            <article
              className="grid gap-4 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto]"
              key={system.id}
            >
              <span>
                <span className="flex flex-wrap items-center gap-2">
                  <strong className="text-[13px] text-text">
                    {system.name}
                  </strong>
                  <StatusBadge status={system.status} />
                  {system.pendingSteps ? (
                    <Badge tone="attention">
                      {system.pendingSteps} pending
                    </Badge>
                  ) : null}
                </span>
                <span className="mt-2 block text-xs leading-5 text-text-secondary">
                  {system.detail}
                </span>
              </span>
              <Button
                variant="secondary"
                onClick={() =>
                  requestConnection(`${system.action}: ${system.name}`)
                }
              >
                {system.action}
                <ExternalLink size={14} aria-hidden="true" />
              </Button>
            </article>
          ))}
        </div>
      </Panel>
      <Panel
        title="Honest limits"
        action={
          <ShieldAlert
            className="text-status-attention"
            size={17}
            aria-hidden="true"
          />
        }
      >
        <div className="grid gap-3 p-5 text-sm leading-6 text-text-secondary">
          <p className="m-0">
            External systems provide evidence, responses, or delivery surfaces.
            They do not grant permissions, schedule work, or decide workflow
            terminal state.
          </p>
          <p className="m-0">
            The browser does not poll external systems or execute pending steps.
            Every remediation command stops at the connection gate.
          </p>
        </div>
      </Panel>
    </div>
  );
}
