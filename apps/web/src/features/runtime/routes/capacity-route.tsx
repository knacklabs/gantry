import { useQuery } from '@tanstack/react-query';
import { Gauge, Settings2 } from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { MetricTile } from '../../../ui/compositions/metric-tile';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import { capacityPreviewQuery } from '../runtime-queries';

export function CapacityRoute() {
  const { data } = useQuery(capacityPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const concurrencyPercent = Math.round(
    (data.concurrencyUsed / data.concurrencyLimit) * 100,
  );
  const budgetPercent = Math.round((data.budgetUsed / data.budgetLimit) * 100);

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <PageHeader
        eyebrow="Runtime"
        title="Capacity"
        description="Active work, queue pressure, concurrency, usage, and budget indicators."
        action={
          <Button
            variant="secondary"
            onClick={() => requestConnection('Change runtime capacity')}
          >
            <Settings2 size={16} aria-hidden="true" />
            Capacity settings
          </Button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile
          label="Active runs"
          value={String(data.activeRuns)}
          detail="currently executing"
        />
        <MetricTile
          label="Queue depth"
          value={String(data.queueDepth)}
          detail="represented work items"
        />
        <MetricTile
          label="Concurrency"
          value={`${data.concurrencyUsed}/${data.concurrencyLimit}`}
          detail="cluster-wide slots"
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Concurrency"
          description="Cluster-wide slot usage"
          action={<Gauge size={17} aria-hidden="true" />}
        >
          <Indicator
            value={concurrencyPercent}
            detail={`${data.concurrencyUsed} of ${data.concurrencyLimit} slots used`}
          />
        </Panel>
        <Panel title="Usage budget" description="Preview daily model spend">
          <Indicator
            value={budgetPercent}
            detail={`$${data.budgetUsed.toFixed(2)} of $${data.budgetLimit.toFixed(2)} used`}
          />
        </Panel>
      </div>
      <Panel
        title="Queue"
        description="Ordered preview work without raw lease details"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-border bg-surface-muted">
                <th className="px-4 py-3">Work</th>
                <th className="px-4 py-3">Agent</th>
                <th className="px-4 py-3">Wait</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.queue.map((item) => (
                <tr
                  className="border-b border-border last:border-0"
                  key={item.id}
                >
                  <td className="px-4 py-3 font-medium text-text">
                    {item.work}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {item.agent}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {item.wait}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={item.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Indicator({ value, detail }: { value: number; detail: string }) {
  return (
    <div className="grid gap-3 p-5">
      <div className="flex items-end justify-between gap-3">
        <strong className="text-3xl text-text">{value}%</strong>
        <span className="text-xs text-text-secondary">{detail}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-strong">
        <div
          className="h-full bg-status-attention"
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
    </div>
  );
}
