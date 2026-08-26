import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Bot, Plus } from 'lucide-react';
import { type FormEvent, useMemo } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { DataTable } from '../../../ui/compositions/data-table';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { SelectField } from '../../../ui/compositions/select-field';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import type { AgentDirectoryItem } from '../agents-queries';
import { agentDirectoryQuery } from '../agents-queries';

export function AgentsRoute() {
  const search = useSearch({ from: '/agents' });
  const navigate = useNavigate({ from: '/agents' });
  const { data, isLoading, isError } = useQuery(
    agentDirectoryQuery({
      page: search.page,
      search: search.q,
      status: search.status,
    }),
  );
  const { requestConnection } = useConnectionGate();
  const visible = data?.items ?? [];

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void navigate({
      search: { ...search, q: String(form.get('q') ?? ''), page: 1 },
    });
  }

  const columns = useMemo<ColumnDef<AgentDirectoryItem>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Agent',
        cell: ({ row }) => (
          <Link
            className="grid min-h-9 content-center text-text no-underline hover:underline"
            params={{ agentId: row.original.id }}
            search={{ tab: 'overview' }}
            to="/agents/$agentId"
          >
            <span className="font-semibold">{row.original.name}</span>
          </Link>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge status={String(getValue())} />,
      },
      {
      { accessorKey: 'updatedAt', header: 'Updated' },
    ],
    [],
  );

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Agents"
        description="Identity, model defaults, attached sources, and conversation installations."
        action={
          <Button onClick={() => requestConnection('Create agent')}>
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
          options={['all', 'active', 'disabled']}
          onChange={(status) =>
            void navigate({ search: { ...search, status, page: 1 } })
          }
        />
        <Button variant="secondary" type="submit">
          Search
        </Button>
      </form>

      <Panel
        title="Agent directory"
        description={isLoading ? 'Loading agents…' : `${data?.total ?? 0} agents`}
        action={<Bot size={16} aria-hidden="true" />}
      >
        <DataTable
          columns={columns}
          data={visible}
          emptyMessage={isError ? 'Agents could not be loaded. Reload this page to retry.' : 'No agents match these filters.'}
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
    <SelectField
      label={label}
      onValueChange={onChange}
      options={options.map((value) => ({
        label:
          value === 'all'
            ? `All ${label.toLowerCase()}s`
            : value.replaceAll('-', ' '),
        value,
      }))}
      value={value}
    />
  );
}
