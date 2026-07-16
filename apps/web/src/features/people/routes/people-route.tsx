import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { UserPlus, Users } from 'lucide-react';
import { type FormEvent, useMemo } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { DataTable } from '../../../ui/compositions/data-table';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import type { PersonPreview } from '../people-preview';
import { peoplePreviewQuery } from '../people-queries';

const providers = ['all', 'Slack', 'Telegram', 'Teams'] as const;
const invitations = ['all', 'accepted', 'pending', 'not_invited'] as const;

export function PeopleRoute() {
  const search = useSearch({ from: '/people' });
  const navigate = useNavigate({ from: '/people' });
  const { data } = useQuery(peoplePreviewQuery);
  const { requestConnection } = useConnectionGate();
  const query = search.q.toLowerCase();
  const visible = data.filter(
    (person) =>
      (search.provider === 'all' ||
        person.aliases.some((alias) => alias.provider === search.provider)) &&
      (search.invitation === 'all' ||
        person.invitation === search.invitation) &&
      (!query ||
        `${person.name} ${person.organization} ${person.aliases.map((alias) => alias.display).join(' ')}`
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

  const columns = useMemo<ColumnDef<PersonPreview>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Person',
        cell: ({ row }) => (
          <Link
            className="grid min-h-9 content-center text-text no-underline hover:underline"
            params={{ personId: row.original.id }}
            search={{ view: 'profile' }}
            to="/people/$personId"
          >
            <span className="font-semibold">{row.original.name}</span>
            <span className="text-xs font-normal text-text-muted">
              {row.original.title}
            </span>
          </Link>
        ),
      },
      { accessorKey: 'organization', header: 'Organization' },
      {
        id: 'providers',
        header: 'Provider aliases',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.aliases.map((alias) => (
              <Badge key={alias.id}>{alias.provider}</Badge>
            ))}
          </div>
        ),
      },
      {
        id: 'conversations',
        header: 'Conversations',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.conversations.length}
          </span>
        ),
      },
      {
        accessorKey: 'invitation',
        header: 'Invitation',
        cell: ({ getValue }) => <StatusBadge status={String(getValue())} />,
      },
    ],
    [],
  );

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Relationships"
        title="People"
        description="Canonical people with provider-alias provenance and conversation context."
        action={
          <Button onClick={() => requestConnection('Invite person')}>
            <UserPlus size={16} aria-hidden="true" />
            Invite person
          </Button>
        }
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
          placeholder="Name, organization, or alias"
        />
        <FilterSelect
          label="Provider"
          options={providers}
          value={search.provider}
          onChange={(provider) =>
            void navigate({ search: { ...search, provider, page: 1 } })
          }
        />
        <FilterSelect
          label="Invitation"
          options={invitations}
          value={search.invitation}
          onChange={(invitation) =>
            void navigate({ search: { ...search, invitation, page: 1 } })
          }
        />
        <Button variant="secondary" type="submit">
          Search
        </Button>
      </form>
      <Panel
        title="People directory"
        description={`${visible.length} of ${data.length} people shown`}
        action={<Users size={17} aria-hidden="true" />}
      >
        <DataTable
          columns={columns}
          data={visible}
          emptyMessage="No people match these filters."
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
            {option === 'all'
              ? `All ${label.toLowerCase()}s`
              : option.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  );
}
