import { useQuery } from '@tanstack/react-query';
import { BrainCircuit, Database, RefreshCw } from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { memoryEnginePreviewQuery } from '../runtime-queries';

export function MemoryEngineRoute() {
  const { data } = useQuery(memoryEnginePreviewQuery);
  const { requestConnection } = useConnectionGate();

  return (
    <div className="mx-auto grid w-full max-w-[1080px] gap-6">
      <PageHeader
        eyebrow="Runtime"
        title="Memory engine"
        description="Pipeline health, stores, review work, and retention summary."
        action={
          <Button
            variant="secondary"
            onClick={() => requestConnection('Refresh memory engine')}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </Button>
        }
      />
      <Panel
        title="Pipeline"
        description="Owner-visible processing stages"
        action={<BrainCircuit size={17} aria-hidden="true" />}
      >
        <div className="grid gap-3 p-4 md:grid-cols-4">
          {data.pipeline.map((stage, index) => (
            <article
              className="relative rounded-md border border-border p-4"
              key={stage.label}
            >
              <span className="font-mono text-[10px] text-text-muted">
                0{index + 1}
              </span>
              <div className="mt-3 flex items-center justify-between gap-2">
                <strong className="text-[13px] text-text">{stage.label}</strong>
                <StatusBadge status={stage.status} />
              </div>
              <p className="mt-2 mb-0 text-xs leading-5 text-text-secondary">
                {stage.detail}
              </p>
            </article>
          ))}
        </div>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel
          title="Stores"
          description="Counts only; remembered content is not exposed here."
          action={<Database size={17} aria-hidden="true" />}
        >
          <div className="divide-y divide-border">
            {data.stores.map((store) => (
              <div
                className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto]"
                key={store.name}
              >
                <span>
                  <strong className="block text-[13px] text-text">
                    {store.name}
                  </strong>
                  <span className="mt-1 block text-xs text-text-secondary">
                    {store.detail}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge>{store.records} records</Badge>
                  <StatusBadge status={store.status} />
                </span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Retention" description="Policy summary">
          <div className="grid gap-4 p-4 text-[13px]">
            <Detail label="Session continuity" value="Policy managed" />
            <Detail label="Remembered information" value="Owner reviewable" />
            <Detail label="Contradictions" value="Retained until resolved" />
            <Detail label="Raw content" value="Not shown in this view" />
            <Button onClick={() => requestConnection('Review memory queue')}>
              Review 4 records
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-border pb-3">
      <span className="block text-xs text-text-muted">{label}</span>
      <strong className="mt-1 block font-medium text-text">{value}</strong>
    </div>
  );
}
