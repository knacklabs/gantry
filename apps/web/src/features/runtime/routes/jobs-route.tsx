import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { CalendarClock, Plus } from 'lucide-react';
import { type FormEvent, useMemo } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { DataTable } from '../../../ui/compositions/data-table';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import type { JobPreview } from '../jobs-preview';
import { jobPreviewQuery } from '../runtime-queries';

const statuses = ['all', 'enabled', 'paused', 'blocked'] as const;

export function JobsRoute() {
  const search = useSearch({ from: '/jobs' });
  const navigate = useNavigate({ from: '/jobs' });
  const { data } = useQuery(jobPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const query = search.q.toLowerCase();
  const visible = data.filter(
    (job) =>
      (search.status === 'all' || job.status === search.status) &&
      (!query ||
        `${job.name} ${job.description} ${job.agent}`
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

  const columns = useMemo<ColumnDef<JobPreview>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Job',
        cell: ({ row }) => (
          <Link
            className="grid min-h-9 content-center text-text no-underline hover:underline"
            params={{ jobId: row.original.id }}
            to="/jobs/$jobId"
          >
            <span className="font-semibold">{row.original.name}</span>
            <span className="max-w-[280px] truncate text-xs font-normal text-text-muted">
              {row.original.description}
            </span>
          </Link>
        ),
      },
      { accessorKey: 'agent', header: 'Agent' },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => <StatusBadge status={String(getValue())} />,
      },
      { accessorKey: 'schedule', header: 'Schedule', enableSorting: false },
      { accessorKey: 'nextRun', header: 'Next run' },
      {
        id: 'action',
        header: 'Action',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.blocker ? (
            <Button
              variant="secondary"
              onClick={() => requestConnection(row.original.blocker!.action)}
            >
              {row.original.blocker.action}
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => requestConnection(`Trigger ${row.original.name}`)}
            >
              Run now
            </Button>
          ),
      },
    ],
    [requestConnection],
  );

  return (
    <div className="mx-auto grid w-full max-w-[1280px] gap-6">
      <PageHeader
        eyebrow="Runtime"
        title="Jobs"
        description="Scheduled definitions, notification routes, blockers, and recent run state."
        action={
          <Button onClick={() => requestConnection('Create job')}>
            <Plus size={16} aria-hidden="true" />
            Create job
          </Button>
        }
      />
      <form
        className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_180px_auto]"
        onSubmit={submitSearch}
      >
        <TextField
          defaultValue={search.q}
          id="job-search"
          label="Search jobs"
          name="q"
          placeholder="Name, agent, or purpose"
        />
        <label className="grid gap-1.5 text-xs font-semibold text-text">
          Status
          <select
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text capitalize"
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
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status === 'all' ? 'All statuses' : status}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" type="submit">
          Search
        </Button>
      </form>
      <Panel
        title="Job definitions"
        description={`${visible.length} of ${data.length} jobs shown`}
        action={<CalendarClock size={17} aria-hidden="true" />}
      >
        <DataTable
          columns={columns}
          data={visible}
          emptyMessage="No jobs match these filters."
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
