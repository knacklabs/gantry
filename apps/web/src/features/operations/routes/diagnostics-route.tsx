import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  ListFilter,
  RefreshCw,
  XCircle,
} from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '../../../ui/primitives/toggle-group';
import { diagnosticPreviewQuery } from '../operations-queries';

const filterOptions = [
  { value: 'all', label: 'All', icon: ListFilter },
  { value: 'passing', label: 'Passing', icon: CheckCircle2 },
  { value: 'warning', label: 'Warnings', icon: AlertTriangle },
  { value: 'failing', label: 'Failing', icon: XCircle },
] as const;

export function DiagnosticsRoute() {
  const search = useSearch({ from: '/diagnostics' });
  const navigate = useNavigate({ from: '/diagnostics' });
  const { data } = useQuery(diagnosticPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const visible = data.filter(
    (item) => search.status === 'all' || item.status === search.status,
  );
  const passing = data.filter((item) => item.status === 'passing').length;

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Diagnostics"
        description="Readiness checks and redacted evidence for operator troubleshooting."
        action={
          <Button
            variant="secondary"
            onClick={() => requestConnection('Run diagnostics')}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Run checks
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Summary label="Passing" value={passing} variant="success" />
        <Summary
          label="Warnings"
          value={data.filter((item) => item.status === 'warning').length}
          variant="attention"
        />
        <Summary
          label="Failing"
          value={data.filter((item) => item.status === 'failing').length}
          variant="destructive"
        />
      </div>

      <ToggleGroup
        aria-label="Diagnostic status"
        type="single"
        value={search.status}
        onValueChange={(status) =>
          status &&
          void navigate({ search: { status: status as typeof search.status } })
        }
      >
        {filterOptions.map(({ icon: Icon, label, value }) => (
          <ToggleGroupItem key={value} value={value} aria-label={label}>
            <Icon size={15} aria-hidden="true" />
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Panel
        title="Health checks"
        description={`${visible.length} checks match the current filter. Secret values are always redacted.`}
      >
        <div className="divide-y divide-border">
          {visible.map((diagnostic) => (
            <article
              className="grid gap-4 px-5 py-5 md:grid-cols-[minmax(0,1fr)_auto]"
              key={diagnostic.id}
            >
              <div className="flex min-w-0 gap-3">
                <span className={iconTone(diagnostic.status)}>
                  <CircleDot size={17} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="m-0 text-sm font-semibold text-text">
                      {diagnostic.check}
                    </h2>
                    <StatusBadge status={diagnostic.status} />
                    <Badge>{diagnostic.area}</Badge>
                  </div>
                  <p className="mt-2 mb-0 text-[13px] font-medium text-text">
                    {diagnostic.summary}
                  </p>
                  <p className="mt-1 mb-0 max-w-2xl text-xs leading-5 text-text-secondary">
                    {diagnostic.detail}
                  </p>
                  <p className="mt-2 mb-0 font-mono text-[10px] text-text-muted">
                    check:{diagnostic.id} · {diagnostic.checkedAt} ·
                    secrets:[redacted]
                  </p>
                </div>
              </div>
              {diagnostic.status !== 'passing' ? (
                <Button
                  variant="secondary"
                  onClick={() =>
                    requestConnection(`Resolve ${diagnostic.check}`)
                  }
                >
                  Review
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Summary({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: 'success' | 'attention' | 'destructive';
}) {
  return (
    <div className="rounded-md border border-border bg-surface p-4 shadow-panel">
      <p className="m-0 text-xs font-semibold text-text-secondary">{label}</p>
      <div className="mt-2 flex items-center justify-between">
        <strong className="text-2xl text-text">{value}</strong>
        <Badge variant={variant}>{label.toLowerCase()}</Badge>
      </div>
    </div>
  );
}

function iconTone(status: 'passing' | 'warning' | 'failing') {
  if (status === 'passing') return 'text-status-success';
  if (status === 'warning') return 'text-status-attention';
  return 'text-danger';
}
