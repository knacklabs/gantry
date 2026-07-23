import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Bot, Plus } from 'lucide-react';
import { type FormEvent, useMemo } from 'react';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { DataTable } from '../../../ui/compositions/data-table';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import { loadAgents, type LiveAgent } from '../agents-api';
import { agentQueryKeys } from '../agents-queries';

export function AgentsRoute() {
  const search = useSearch({ from: '/agents' });
  const navigate = useNavigate({ from: '/agents' });
  const connection = useRuntimeConnection();
  const {
    data = [],
    isPending,
    isError,
  } = useQuery({
    queryKey: agentQueryKeys.list(),
    enabled: Boolean(connection.transport),
    queryFn: () => loadAgents(connection.transport!),
  });
  const { requestConnection } = useConnectionGate();
  const query = search.q.toLowerCase();
  const visible = data.filter(
    (agent) =>
      (search.status === 'all' || statusFor(agent) === search.status) &&
      search.model === 'all' &&
      (!query ||
        `${agent.name} ${agent.description}`.toLowerCase().includes(query)),
  );

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void navigate({
      search: { ...search, q: String(form.get('q') ?? ''), page: 1 },
    });
  }

  const columns = useMemo<ColumnDef<LiveAgent>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Agent',
        cell: ({ row }) =>
          row.original.setupState === 'draft' ? (
            <button
              className="grid min-h-9 content-center text-left text-text hover:underline"
              onClick={() =>
                void navigate({ search: { ...search, setup: row.original.id } })
              }
              type="button"
            >
              <span className="font-semibold">{row.original.name}</span>
              <span className="max-w-[280px] truncate text-xs font-normal text-text-muted">
                {row.original.description ?? row.original.id}
              </span>
            </button>
          ) : (
            <Link
              className="grid min-h-9 content-center text-text no-underline hover:underline"
              params={{ agentId: row.original.id }}
              search={{ tab: 'identity' }}
              to="/agents/$agentId"
            >
              <span className="font-semibold">{row.original.name}</span>
              <span className="max-w-[280px] truncate text-xs font-normal text-text-muted">
                {row.original.description ?? row.original.id}
              </span>
            </Link>
          ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusBadge status={statusFor(row.original)} />,
      },
      {
        accessorKey: 'modelAlias',
        header: 'Model',
        cell: ({ row }) => (
          <span>
            <span className="block font-medium text-text">Default</span>
            <span className="font-mono text-[10px] text-text-muted">
              {row.original.agentHarness}
            </span>
          </span>
        ),
      },
      {
        id: 'conversations',
        header: 'Conversations',
        cell: () => '—',
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        cell: ({ getValue }) => new Date(String(getValue())).toLocaleString(),
      },
    ],
    [navigate, search],
  );

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Agents"
        description="Identity, model defaults, attached sources, and conversation installations."
        action={
          <Button
            onClick={() => {
              if (!connection.transport)
                return requestConnection('Create agent');
              void navigate({ search: { ...search, setup: 'new' } });
            }}
          >
            <Plus size={16} aria-hidden="true" />
            Create agent
          </Button>
        }
      />

      <form
        className="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_170px_150px_auto]"
        onSubmit={submitSearch}
      >
        <TextField
          defaultValue={search.q}
          id="agent-search"
          label="Search agents"
          name="q"
          placeholder="Name or purpose"
        />
        <FilterSelect
          label="Status"
          value={search.status}
          options={['all', 'active', 'disabled', 'draft']}
          onChange={(status) =>
            void navigate({ search: { ...search, status, page: 1 } })
          }
        />
        <FilterSelect
          label="Model"
          value={search.model}
          options={['all']}
          onChange={(model) =>
            void navigate({ search: { ...search, model, page: 1 } })
          }
        />
        <Button variant="secondary" type="submit">
          Search
        </Button>
      </form>

      <Panel
        title="Agent directory"
        description={`${visible.length} of ${data.length} agents shown`}
        action={<Bot size={16} aria-hidden="true" />}
      >
        <DataTable
          columns={columns}
          data={isPending ? [] : visible}
          emptyMessage={
            isError
              ? 'Agents could not be loaded. Check the Gantry connection and try again.'
              : isPending
                ? 'Loading agents…'
                : data.length === 0
                  ? 'No agents yet. Create your first agent to get started.'
                  : 'No agents match these filters.'
          }
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
    </div>
  );
}

function statusFor(agent: LiveAgent): 'active' | 'disabled' | 'draft' {
  return agent.setupState === 'draft' ? 'draft' : agent.status;
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
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
            {option === 'all'
              ? `All ${label.toLowerCase()}s`
              : option.replaceAll('-', ' ')}
          </option>
        ))}
      </select>
    </label>
  );
}
