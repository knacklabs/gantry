import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { MessagesSquare, RefreshCw } from 'lucide-react';
import { type FormEvent, useMemo } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { DataTable } from '../../../ui/compositions/data-table';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import type { ConversationPreview } from '../operations-preview';
import { conversationPreviewQuery } from '../operations-queries';

export function ConversationsRoute() {
  const search = useSearch({ from: '/conversations' });
  const navigate = useNavigate({ from: '/conversations' });
  const { data } = useQuery(conversationPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const query = search.q.toLowerCase();
  const visible = data.filter(
    (conversation) =>
      (search.status === 'all' || conversation.status === search.status) &&
      (!query ||
        `${conversation.name} ${conversation.provider} ${conversation.agent}`
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

  const columns = useMemo<ColumnDef<ConversationPreview>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Conversation',
        cell: ({ row }) => (
          <Link
            className="grid min-h-9 content-center text-text no-underline hover:underline"
            params={{ conversationId: row.original.id }}
            to="/conversations/$conversationId"
          >
            <span className="font-semibold">{row.original.name}</span>
            <span className="text-xs font-normal text-text-muted">
              {row.original.kind}
            </span>
          </Link>
        ),
      },
      { accessorKey: 'provider', header: 'Provider' },
      { accessorKey: 'agent', header: 'Installed agent' },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge status={String(getValue())} />,
      },
      { accessorKey: 'activity', header: 'Last activity' },
    ],
    [],
  );

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Conversations"
        description="Discovered channels, groups, and direct conversations available to Gantry."
        action={
          <Button
            variant="secondary"
            onClick={() => requestConnection('Refresh conversations')}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <form
        className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_190px_auto]"
        onSubmit={submitSearch}
      >
        <TextField
          defaultValue={search.q}
          id="conversation-search"
          label="Search conversations"
          name="q"
          placeholder="Name, provider, or agent"
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
            <option value="active">Active</option>
            <option value="quiet">Quiet</option>
            <option value="blocked">Blocked</option>
          </select>
        </label>
        <Button variant="secondary" type="submit">
          Search
        </Button>
      </form>

      <Panel
        title="Conversation directory"
        description={`${visible.length} of ${data.length} conversations shown`}
        action={
          <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
            <MessagesSquare size={15} aria-hidden="true" />
            Preview snapshot
          </span>
        }
      >
        <DataTable
          columns={columns}
          data={visible}
          emptyMessage="No conversations match these filters."
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
