import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Boxes, Settings2 } from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { MetricTile } from '../../../ui/compositions/metric-tile';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { modelPreviewQuery } from '../runtime-queries';

const families = ['all', 'Anthropic', 'OpenAI', 'OpenRouter'] as const;

export function ModelsRoute() {
  const search = useSearch({ from: '/runtime/models' });
  const navigate = useNavigate({ from: '/runtime/models' });
  const { data } = useQuery(modelPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const visible = data.filter(
    (model) => search.family === 'all' || model.family === search.family,
  );
  const totalRequests = data.reduce((sum, model) => sum + model.requests24h, 0);

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <PageHeader
        eyebrow="Runtime"
        title="Models"
        description="Friendly aliases, harness compatibility, readiness, and usage."
        action={
          <Button onClick={() => requestConnection('Change model defaults')}>
            <Settings2 size={16} aria-hidden="true" />
            Model defaults
          </Button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile
          label="Aliases"
          value={String(data.length)}
          detail="registered preview routes"
        />
        <MetricTile
          label="Requests · 24h"
          value={String(totalRequests)}
          detail="across all aliases"
        />
        <MetricTile label="Cost · 24h" value="$12.40" detail="of $50 budget" />
      </div>
      <label className="grid max-w-[240px] gap-1.5 text-xs font-semibold text-text">
        Model family
        <select
          className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
          value={search.family}
          onChange={(event) =>
            void navigate({
              search: { family: event.target.value as typeof search.family },
            })
          }
        >
          {families.map((family) => (
            <option key={family} value={family}>
              {family === 'all' ? 'All families' : family}
            </option>
          ))}
        </select>
      </label>
      <Panel
        title="Model catalog"
        description={`${visible.length} aliases shown`}
        action={<Boxes size={17} aria-hidden="true" />}
      >
        <div className="divide-y divide-border">
          {visible.map((model) => (
            <article
              className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_auto]"
              key={model.alias}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="font-mono text-sm text-text">
                    {model.alias}
                  </strong>
                  <Badge>{model.family}</Badge>
                  <StatusBadge status={model.readiness} />
                </div>
                <p className="mt-3 mb-0 text-xs text-text-secondary">
                  Compatible harnesses
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {model.compatibleHarnesses.map((harness) => (
                    <Badge key={harness}>{harness}</Badge>
                  ))}
                </div>
              </div>
              <dl className="m-0 grid grid-cols-3 gap-5 text-right text-xs">
                <Usage label="Requests" value={String(model.requests24h)} />
                <Usage label="Tokens" value={model.tokens24h} />
                <Usage label="Cost" value={model.cost24h} />
              </dl>
            </article>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Usage({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-text-muted">{label}</dt>
      <dd className="mt-1 ml-0 font-mono text-text">{value}</dd>
    </div>
  );
}
