import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { KeyRound, PlugZap, RefreshCw } from 'lucide-react';
import { type FormEvent, useMemo } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { DataTable } from '../../../ui/compositions/data-table';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import type { ProviderPreview } from '../operations-preview';
import { providerPreviewQuery } from '../operations-queries';

export function ProvidersRoute() {
  const search = useSearch({ from: '/providers' });
  const navigate = useNavigate({ from: '/providers' });
  const { data } = useQuery(providerPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const visible = data.filter((provider) => {
    const query = search.q.toLowerCase();
    return (
      (search.status === 'all' || provider.status === search.status) &&
      (!query ||
        `${provider.name} ${provider.kind} ${provider.account}`
          .toLowerCase()
          .includes(query))
    );
  });
  const selected =
    data.find((provider) => provider.id === search.selected) ?? data[0];

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void navigate({
      search: { ...search, q: String(form.get('q') ?? ''), page: 1 },
    });
  }

  const columns = useMemo<ColumnDef<ProviderPreview>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Provider',
        cell: ({ row }) => (
          <button
            className="grid min-h-9 content-center text-left"
            type="button"
            onClick={() =>
              void navigate({
                search: { ...search, selected: row.original.id },
              })
            }
          >
            <span className="font-semibold text-text">{row.original.name}</span>
            <span className="text-xs text-text-muted">
              {row.original.account}
            </span>
          </button>
        ),
      },
      { accessorKey: 'kind', header: 'Type' },
      {
        accessorKey: 'conversations',
        header: 'Conversations',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs">{String(getValue())}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge status={String(getValue())} />,
      },
      {
        accessorKey: 'discoveredAt',
        header: 'Last discovery',
        enableSorting: false,
      },
    ],
    [navigate, search],
  );

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Providers"
        description="Installed channel and model-provider accounts with readiness evidence."
        action={
          <Button onClick={() => requestConnection('Add provider')}>
            <PlugZap size={16} aria-hidden="true" />
            Add provider
          </Button>
        }
      />

      <form
        className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_190px_auto]"
        onSubmit={submitSearch}
      >
        <TextField
          defaultValue={search.q}
          id="provider-search"
          label="Search providers"
          name="q"
          placeholder="Name, type, or account"
        />
        <label className="grid gap-1.5 text-xs font-semibold text-text">
          Status
          <select
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
            value={search.status}
            onChange={(event) =>
              void navigate({
                search: {
                  ...search,
                  status: event.target.value as typeof search.status,
                  page: 1,
                },
              })
            }
          >
            <option value="all">All statuses</option>
            <option value="ready">Ready</option>
            <option value="attention">Needs attention</option>
            <option value="offline">Offline</option>
          </select>
        </label>
        <Button variant="secondary" type="submit">
          Search
        </Button>
      </form>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel
          title="Provider accounts"
          description="Select an account to inspect its preview readiness."
        >
          <DataTable
            columns={columns}
            data={visible}
            emptyMessage="No providers match these filters."
            page={search.page}
            sort={search.sort}
            descending={search.desc}
            onPageChange={(page) =>
              void navigate({ search: { ...search, page } })
            }
            onSortChange={(sort, desc) =>
              void navigate({
                search: {
                  ...search,
                  sort: sort as typeof search.sort,
                  desc,
                  page: 1,
                },
              })
            }
          />
        </Panel>

        <Panel
          title={selected.name}
          description={selected.kind}
          action={<StatusBadge status={selected.status} />}
        >
          <div className="grid gap-5 p-4">
            <p className="m-0 text-sm leading-6 text-text-secondary">
              {selected.detail}
            </p>
            <dl className="m-0 grid gap-3 text-[13px]">
              <Detail label="Account" value={selected.account} />
              <Detail
                label="Conversations"
                value={String(selected.conversations)}
              />
              <Detail label="Last discovery" value={selected.discoveredAt} />
              <Detail label="Provider ID" value={selected.id} mono />
            </dl>
            <div className="grid gap-2">
              <Button
                onClick={() => requestConnection(`Refresh ${selected.name}`)}
              >
                <RefreshCw size={16} aria-hidden="true" />
                Refresh discovery
              </Button>
              <Button
                variant="secondary"
                onClick={() => requestConnection(`Configure ${selected.name}`)}
              >
                <KeyRound size={16} aria-hidden="true" />
                Review credentials
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
      <dt className="text-text-muted">{label}</dt>
      <dd
        className={`m-0 min-w-0 break-words text-text ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
