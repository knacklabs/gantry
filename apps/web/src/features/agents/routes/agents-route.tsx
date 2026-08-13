import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Bot, CircleOff, RefreshCw, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  agentsQuery,
  uiApiErrorMessage,
  type UiAgent,
} from '../../../lib/ui-api';
import { DataTable } from '../../../ui/compositions/data-table';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '../../../ui/primitives/alert';
import { Button } from '../../../ui/primitives/button';

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function AgentsRoute() {
  const search = useSearch({ from: '/agents' });
  const navigate = useNavigate({ from: '/agents' });
  const query = useQuery(agentsQuery);
  const [searchText, setSearchText] = useState(search.q);
  const searchInput = useRef(search.q);
  const searchTimeout = useRef<number | undefined>(undefined);
  const agents = query.data?.agents ?? [];
  const visible = useMemo(() => {
    const normalized = searchText.trim().toLowerCase();
    return agents.filter(
      (agent) => !normalized || agent.name.toLowerCase().includes(normalized),
    );
  }, [agents, searchText]);
  const sort =
    search.sort === 'name' || search.sort === 'status' ? search.sort : 'name';

  useEffect(() => {
    return () => window.clearTimeout(searchTimeout.current);
  }, []);

  function updateSearch(value: string) {
    searchInput.current = value;
    window.clearTimeout(searchTimeout.current);
    searchTimeout.current = window.setTimeout(
      () => setSearchText(searchInput.current),
      200,
    );
  }

  function applyPendingSearch() {
    window.clearTimeout(searchTimeout.current);
    setSearchText(searchInput.current);
  }

  const columns = useMemo<ColumnDef<UiAgent>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Agent',
        cell: ({ row }) => (
          <Link
            className="font-semibold text-text no-underline hover:underline"
            params={{ agentId: row.original.id }}
            search={{ tab: 'summary' }}
            to="/agents/$agentId"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge status={String(getValue())} />,
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        enableSorting: false,
        cell: ({ getValue }) => <Timestamp value={String(getValue())} />,
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        enableSorting: false,
        cell: ({ getValue }) => <Timestamp value={String(getValue())} />,
      },
    ],
    [],
  );

  return (
    <div className="agent-directory mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Agents"
        description="Inspect configured agent composition and recent activity from this Gantry deployment."
        action={
          <Button
            disabled={query.isFetching}
            variant="secondary"
            onClick={() => void query.refetch({ cancelRefetch: false })}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {query.isFetching ? 'Refreshing' : 'Refresh'}
          </Button>
        }
      />

      {query.isPending ? (
        <PageState
          description="Reading the agent directory from Gantry."
          icon={<Bot aria-hidden="true" />}
          kind="loading"
          title="Loading agents"
        />
      ) : null}

      {query.isError && !query.data ? (
        <PageState
          action={
            <Button
              disabled={query.isFetching}
              onClick={() => void query.refetch({ cancelRefetch: false })}
            >
              Retry
            </Button>
          }
          description={uiApiErrorMessage(query.error)}
          icon={<CircleOff aria-hidden="true" />}
          kind="offline"
          title="Agents are unavailable"
        />
      ) : null}

      {query.data ? (
        <>
          {query.isError ? (
            <Alert className="border-status-attention/50 bg-status-attention-soft">
              <RefreshCw aria-hidden="true" />
              <AlertTitle>Showing the last successful agent list</AlertTitle>
              <AlertDescription>
                {uiApiErrorMessage(query.error)} Refresh to try again.
              </AlertDescription>
            </Alert>
          ) : null}

          {agents.length === 0 ? (
            <PageState
              description="This deployment has not reported any agents."
              icon={<Bot aria-hidden="true" />}
              kind="empty"
              title="No agents found"
            />
          ) : (
            <>
              <div className="agent-directory-search max-w-xl">
                <TextField
                  defaultValue={search.q}
                  id="agent-search"
                  label="Search agents"
                  name="q"
                  onChange={(event) => updateSearch(event.target.value)}
                  placeholder="Filter by agent name"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') applyPendingSearch();
                  }}
                />
              </div>

              <Panel
                title="Agent directory"
                description={`${visible.length} of ${agents.length} agents shown`}
                action={<Bot size={16} aria-hidden="true" />}
              >
                {visible.length === 0 ? (
                  <div className="p-4">
                    <PageState
                      description="Clear or change the search to see agents."
                      icon={<SearchX aria-hidden="true" />}
                      kind="empty"
                      title="No agents match this search"
                    />
                  </div>
                ) : (
                  <DataTable
                    columns={columns}
                    data={visible}
                    emptyMessage="No agents match this search."
                    page={search.page}
                    sort={sort}
                    descending={search.desc}
                    onPageChange={(page) =>
                      void navigate({ search: { ...search, page } })
                    }
                    onSortChange={(nextSort, desc) =>
                      void navigate({
                        search: {
                          ...search,
                          sort: nextSort as 'name' | 'status',
                          desc,
                          page: 1,
                        },
                      })
                    }
                  />
                )}
              </Panel>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function Timestamp({ value }: { value: string }) {
  const date = new Date(value);
  return (
    <time dateTime={value} title={value}>
      {Number.isNaN(date.valueOf()) ? value : dateTimeFormatter.format(date)}
    </time>
  );
}
