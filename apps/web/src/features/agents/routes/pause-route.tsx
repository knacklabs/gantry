import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, PauseCircle } from 'lucide-react';
import { useState } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { MetricTile } from '../../../ui/compositions/metric-tile';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import { Checkbox } from '../../../ui/primitives/checkbox';
import { agentPreviewQuery } from '../agents-queries';

export function PauseRoute() {
  const { data: agents } = useQuery(agentPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const [confirmed, setConfirmed] = useState(false);
  const deployed = agents.filter(
    (agent) => agent.status === 'deployed' || agent.status === 'blocked',
  );
  const conversations = new Set(
    deployed.flatMap((agent) => agent.conversations),
  );
  const runsToday = deployed.reduce(
    (total, agent) => total + agent.runsToday,
    0,
  );

  return (
    <div className="mx-auto grid w-full max-w-[1000px] gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Pause everywhere"
        description="Review the represented impact before pausing all deployed agents."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile
          label="Affected agents"
          value={String(deployed.length)}
          detail="deployed or blocked"
        />
        <MetricTile
          label="Conversations"
          value={String(conversations.size)}
          detail="active installations"
        />
        <MetricTile
          label="Runs today"
          value={String(runsToday)}
          detail="represented activity"
        />
      </div>

      <Panel
        title="Impact preview"
        description="No state changes occur while Gantry is disconnected."
        action={
          <AlertTriangle
            className="text-status-attention"
            size={18}
            aria-hidden="true"
          />
        }
      >
        <div className="divide-y divide-border">
          {deployed.map((agent) => (
            <div
              className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              key={agent.id}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-[13px] text-text">
                    {agent.name}
                  </strong>
                  <StatusBadge status={agent.status} />
                </div>
                <p className="mt-1 mb-0 text-xs text-text-secondary">
                  {agent.conversations.length
                    ? `${agent.conversations.length} conversation installations · ${agent.runsToday} runs today`
                    : `No conversation installations · ${agent.runsToday} runs today`}
                </p>
              </div>
              <span className="font-mono text-[10px] text-text-muted">
                agent:{agent.id}
              </span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="Confirm pause"
        description="This command would stop new turns and scheduled work for affected agents."
      >
        <div className="grid gap-5 p-5">
          <div className="rounded-md border border-status-attention/40 bg-status-attention-soft p-4 text-sm leading-6 text-status-attention">
            Active runs may need explicit cancellation or may finish according
            to runtime policy. Pausing is not a substitute for revoking access.
          </div>
          <Checkbox
            checked={confirmed}
            id="confirm-pause"
            label="I understand that this would pause every represented deployed agent."
            onCheckedChange={setConfirmed}
          />
          <div>
            <Button
              disabled={!confirmed}
              variant="danger"
              onClick={() => requestConnection('Pause all deployed agents')}
            >
              <PauseCircle size={16} aria-hidden="true" />
              Pause everywhere
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
