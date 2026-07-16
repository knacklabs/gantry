import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Activity, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { type FormEvent } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { IconButton } from '../../../ui/primitives/icon-button';
import { activityPreviewQuery } from '../runtime-queries';

const pageSize = 5;
const types = [
  'all',
  'agent',
  'job',
  'permission',
  'provider',
  'settings',
] as const;
const outcomes = ['all', 'success', 'attention', 'failed'] as const;

export function ActivityRoute() {
  const search = useSearch({ from: '/activity' });
  const navigate = useNavigate({ from: '/activity' });
  const { data } = useQuery(activityPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const query = search.q.toLowerCase();
  const filtered = data.filter(
    (event) =>
      (search.type === 'all' || event.type === search.type) &&
      (search.outcome === 'all' || event.outcome === search.outcome) &&
      (!query ||
        `${event.actor} ${event.resource} ${event.summary}`
          .toLowerCase()
          .includes(query)),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(search.page, pageCount);
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  const selected =
    data.find((event) => event.id === search.selected) ?? visible[0] ?? data[0];

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void navigate({
      search: { ...search, q: String(form.get('q') ?? ''), page: 1 },
    });
  }

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Observability"
        title="Activity"
        description="Owner-visible runtime events with redacted evidence and stable filters."
        action={<Badge>{data.length} preview events</Badge>}
      />
      <form
        className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_160px_160px_auto]"
        onSubmit={submitSearch}
      >
        <TextField
          defaultValue={search.q}
          id="activity-search"
          label="Search activity"
          name="q"
          placeholder="Actor, resource, or summary"
        />
        <FilterSelect
          label="Type"
          options={types}
          value={search.type}
          onChange={(type) =>
            void navigate({ search: { ...search, type, page: 1 } })
          }
        />
        <FilterSelect
          label="Outcome"
          options={outcomes}
          value={search.outcome}
          onChange={(outcome) =>
            void navigate({ search: { ...search, outcome, page: 1 } })
          }
        />
        <Button variant="secondary" type="submit">
          <Search size={15} aria-hidden="true" />
          Search
        </Button>
      </form>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel
          title="Timeline"
          description={`${filtered.length} matching events`}
          action={<Activity size={17} aria-hidden="true" />}
        >
          <div className="divide-y divide-border">
            {visible.map((event) => (
              <button
                aria-pressed={selected.id === event.id}
                className={`grid w-full gap-3 px-5 py-4 text-left hover:bg-surface-muted sm:grid-cols-[90px_minmax(0,1fr)_auto] ${selected.id === event.id ? 'bg-surface-strong' : 'bg-transparent'}`}
                key={event.id}
                type="button"
                onClick={() =>
                  void navigate({ search: { ...search, selected: event.id } })
                }
              >
                <span className="text-xs text-text-muted">{event.time}</span>
                <span className="min-w-0">
                  <strong className="block text-[13px] text-text">
                    {event.summary}
                  </strong>
                  <span className="mt-1 block truncate text-xs text-text-secondary">
                    {event.actor} · {event.resource}
                  </span>
                </span>
                <StatusBadge status={event.outcome} />
              </button>
            ))}
            {visible.length === 0 ? (
              <p className="m-0 p-10 text-center text-xs text-text-secondary">
                No activity matches these filters.
              </p>
            ) : null}
          </div>
          <div className="flex min-h-14 items-center justify-between border-t border-border px-4 text-xs text-text-secondary">
            <span>
              Cursor page {page} of {pageCount}
            </span>
            <div className="flex gap-1">
              <IconButton
                aria-label="Previous activity page"
                disabled={page <= 1}
                title="Previous activity page"
                onClick={() =>
                  void navigate({ search: { ...search, page: page - 1 } })
                }
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </IconButton>
              <IconButton
                aria-label="Next activity page"
                disabled={page >= pageCount}
                title="Next activity page"
                onClick={() =>
                  void navigate({ search: { ...search, page: page + 1 } })
                }
              >
                <ChevronRight size={16} aria-hidden="true" />
              </IconButton>
            </div>
          </div>
        </Panel>
        <Panel
          title="Event detail"
          description={selected.id}
          action={<StatusBadge status={selected.outcome} />}
        >
          <div className="grid gap-4 p-5">
            <Detail label="Type" value={selected.type} />
            <Detail label="Actor" value={selected.actor} />
            <Detail label="Resource" value={selected.resource} />
            <Detail label="Time" value={selected.time} />
            <div className="border-t border-border pt-4">
              <p className="m-0 text-sm leading-6 text-text-secondary">
                {selected.detail}
              </p>
              <p className="mt-3 mb-0 font-mono text-[10px] text-text-muted">
                raw payload:[redacted]
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={() => requestConnection(`Open ${selected.resource}`)}
            >
              Open resource
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function FilterSelect<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-text">
      {label}
      <select
        className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text capitalize"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option === 'all' ? `All ${label.toLowerCase()}s` : option}
          </option>
        ))}
      </select>
    </label>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-xs text-text-muted">{label}</span>
      <strong className="mt-1 block text-[13px] font-medium text-text capitalize">
        {value}
      </strong>
    </div>
  );
}
