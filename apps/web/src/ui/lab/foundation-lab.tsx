import {
  AlertTriangle,
  CloudOff,
  Inbox,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '../primitives/badge';
import { Button } from '../primitives/button';
import { useConnectionGate } from '../compositions/connection-gate';
import { MetricTile } from '../compositions/metric-tile';
import { PageHeader } from '../compositions/page-header';
import { PageState } from '../compositions/page-state';
import { Panel } from '../compositions/panel';
import { StatusList } from '../compositions/status-list';
import { TextField } from '../compositions/text-field';

export function FoundationLab() {
  const { requestConnection } = useConnectionGate();

  return (
    <section
      className="grid max-w-[1180px] gap-8"
      aria-labelledby="component-lab-title"
    >
      <PageHeader
        description="Development-only reference for shared Gantry components and states."
        eyebrow="UI system"
        id="component-lab-title"
        title="Component lab"
      />

      <LabSection title="Actions and status">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => requestConnection('Deploy agent')}
          >
            Deploy agent
          </Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
          <Badge>Neutral</Badge>
          <Badge tone="attention">Needs attention</Badge>
          <Badge tone="success">Healthy</Badge>
          <Badge tone="danger">Blocked</Badge>
        </div>
      </LabSection>

      <div className="grid gap-4 md:grid-cols-2">
        <LabSection title="Fields">
          <div className="grid gap-4">
            <TextField
              id="lab-name"
              label="Agent name"
              placeholder="Research assistant"
            />
            <TextField
              error="A model alias is required."
              id="lab-model"
              label="Model alias"
            />
          </div>
        </LabSection>
        <Panel
          title="Readiness"
          action={<Badge tone="attention">2 blockers</Badge>}
        >
          <StatusList
            items={[
              {
                id: 'runtime',
                label: 'Runtime',
                meta: 'runtime_check',
                tone: 'success',
              },
              {
                id: 'credential',
                label: 'OpenRouter key not set',
                meta: 'missing_credential',
                tone: 'attention',
              },
              {
                id: 'binding',
                label: '#ops-alerts has no agent',
                meta: 'missing_binding',
                tone: 'danger',
              },
            ]}
          />
        </Panel>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile detail="2 live now" label="Conversations" value="4" />
        <MetricTile detail="3 deployed" label="Agents" value="4" />
        <MetricTile detail="2 streaming" label="Runs · 24h" value="142" />
        <MetricTile detail="of $50 budget" label="Cost today" value="$12.40" />
      </div>

      <LabSection title="Page states">
        <div className="grid gap-3 lg:grid-cols-2">
          <PageState
            description="Preview records are being prepared."
            icon={<LoaderCircle size={20} />}
            kind="loading"
            title="Loading"
          />
          <PageState
            description="No records match the current filters."
            icon={<Inbox size={20} />}
            kind="empty"
            title="Nothing here"
          />
          <PageState
            description="The preview record could not be rendered."
            icon={<AlertTriangle size={20} />}
            kind="error"
            title="Something went wrong"
          />
          <PageState
            description="Live Gantry data is unavailable."
            icon={<CloudOff size={20} />}
            kind="offline"
            title="Not connected"
          />
          <PageState
            description="Waiting to refresh authoritative data."
            icon={<RefreshCw size={20} />}
            kind="reconnecting"
            title="Reconnecting"
          />
        </div>
      </LabSection>
    </section>
  );
}

function LabSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="grid gap-3 rounded-lg border border-border bg-surface p-4 shadow-panel">
      <h2 className="m-0 text-sm font-semibold text-text">{title}</h2>
      {children}
    </section>
  );
}
