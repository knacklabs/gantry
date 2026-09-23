import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { RefreshCw, Users } from 'lucide-react';
import { type FormEvent, useMemo } from 'react';

import { DataTable } from '../../../ui/compositions/data-table';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { SelectField } from '../../../ui/compositions/select-field';
import { TextField } from '../../../ui/compositions/text-field';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  type BrowserPersonDirectoryItem,
  peopleDirectoryQuery,
} from '../people-queries';

const statuses = ['all', 'active', 'disabled', 'archived'] as const;

export function PeopleRoute() {
  const search = useSearch({ from: '/people' });
  const navigate = useNavigate({ from: '/people' });
  const directory = useQuery(peopleDirectoryQuery);
  const people = directory.data ?? [];
  const providers = useMemo(
    () => [
      'all',
      ...new Set(
        people.flatMap((person) =>
          person.aliases.map((alias) => alias.provider),
        ),
      ),
    ],
    [people],
  );
  const query = search.q.trim().toLowerCase();
  const visible = people.filter(
    (person) =>
      (search.provider === 'all' ||
        person.aliases.some((alias) => alias.provider === search.provider)) &&
      (search.status === 'all' || person.status === search.status) &&
      (!query ||
        `${person.displayName} ${person.aliases.map((alias) => `${alias.provider} ${alias.displayName ?? ''}`).join(' ')}`
          .toLowerCase()
          .includes(query)),
  );

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void navigate({
      search: { ...search, q: String(form.get('q') ?? ''), page: 1 },
    });
  }

  const columns = useMemo<ColumnDef<BrowserPersonDirectoryItem>[]>(
    () => [
      {
        accessorKey: 'displayName',
        header: 'Person',
        cell: ({ row }) => (
          <Link
            className="grid min-h-9 content-center text-text no-underline hover:underline"
            params={{ personId: row.original.id }}
            to="/people/$personId"
          >
            <span className="font-semibold">{row.original.displayName}</span>
            <span className="text-xs font-normal text-text-muted">
              {row.original.kind === 'service' ? 'Service identity' : 'Human'}
            </span>
          </Link>
        ),
      },
      {
        id: 'aliases',
        header: 'Provider identities',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.aliases.length ? (
            <div className="flex flex-wrap gap-1">
              {row.original.aliases.map((alias) => (
                <Badge key={alias.id}>{alias.provider}</Badge>
              ))}
            </div>
          ) : (
            <span className="text-text-muted">None</span>
          ),
      },
      {
        id: 'verification',
        header: 'Verification',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.aliasCounts.verified ?? 0} verified ·{' '}
            {row.original.aliasCounts.unverified ?? 0} unverified
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge status={String(getValue())} />,
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        cell: ({ getValue }) =>
          new Date(String(getValue())).toLocaleDateString(),
      },
    ],
    [],
  );

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Relationships"
        title="People"
        description="People and service identities recorded from your connected accounts."
      />
      <form
        className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_160px_180px_auto]"
        onSubmit={submitSearch}
      >
        <TextField
          defaultValue={search.q}
          id="people-search"
          label="Search people"
          name="q"
          placeholder="Name or provider identity"
        />
        <SelectField
          label="Provider"
          value={search.provider}
          onValueChange={(provider) =>
            void navigate({ search: { ...search, provider, page: 1 } })
          }
          options={providers.map((provider) => ({
            value: provider,
            label: provider === 'all' ? 'All providers' : provider,
          }))}
        />
        <SelectField
          label="Status"
          value={search.status}
          onValueChange={(status) =>
            void navigate({
              search: {
                ...search,
                status: status as typeof search.status,
                page: 1,
              },
            })
          }
          options={statuses.map((status) => ({
            value: status,
            label: status === 'all' ? 'All statuses' : status,
          }))}
        />
        <Button variant="secondary" type="submit">
          Search
        </Button>
      </form>
      <Panel
        title="People directory"
        description={`${visible.length} of ${people.length} recorded identities shown`}
        action={<Users size={17} aria-hidden="true" />}
      >
        {directory.isPending ? (
          <PageState
            kind="loading"
            icon={<Users size={18} />}
            title="Loading people"
            description="Reading recorded identities."
          />
        ) : directory.isError ? (
          <PageState
            kind="error"
            icon={<Users size={18} />}
            title="People could not be loaded"
            description="Try loading the directory again."
            action={
              <Button onClick={() => void directory.refetch()}>
                <RefreshCw size={15} /> Retry
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={visible}
            emptyMessage={
              people.length
                ? 'No people match these filters.'
                : 'No people recorded yet. Identities appear as they are observed through connected accounts.'
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
        )}
      </Panel>
    </div>
  );
}
