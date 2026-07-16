import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { GitBranch, Play, Plus } from 'lucide-react';
import { type FormEvent } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  workflowPreviewQuery,
  workflowRunPreviewQuery,
} from '../workflows-queries';

const statuses = ['all', 'enabled', 'disabled', 'draft'] as const;

export function WorkflowsRoute() {
  const search = useSearch({ from: '/workflows' });
  const navigate = useNavigate({ from: '/workflows' });
  const { data: workflows } = useQuery(workflowPreviewQuery);
  const { data: runs } = useQuery(workflowRunPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const query = search.q.toLowerCase();
  const visible = workflows.filter(
    (workflow) =>
      (search.status === 'all' || workflow.status === search.status) &&
      (!query ||
        `${workflow.name} ${workflow.description} ${workflow.owner}`
          .toLowerCase()
          .includes(query)),
  );

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void navigate({ search: { ...search, q: String(form.get('q') ?? '') } });
  }

  return (
    <div className="mx-auto grid w-full max-w-[1160px] gap-6">
      <PageHeader
        eyebrow="Automation"
        title="Workflows"
        description="Versioned definitions, validation, external waits, and run evidence."
        action={
          <Link
            className="inline-flex h-9 items-center gap-2 rounded-md border border-ink bg-ink px-3.5 text-[13px] font-semibold text-ink-on no-underline hover:bg-ink-hover"
            search={{ template: 'blank' }}
            to="/workflows/new"
          >
            <Plus size={16} aria-hidden="true" />
            New workflow
          </Link>
        }
      />
      <form
        className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_180px_auto]"
        onSubmit={submitSearch}
      >
        <TextField
          defaultValue={search.q}
          id="workflow-search"
          label="Search workflows"
          name="q"
          placeholder="Name, owner, or purpose"
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
        title="Definitions"
        description={`${visible.length} workflows shown`}
        action={<GitBranch size={17} aria-hidden="true" />}
      >
        <div className="divide-y divide-border">
          {visible.map((workflow) => {
            const latestRun = runs.find((run) =>
              workflow.recentRunIds.includes(run.id),
            );
            return (
              <article
                className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_auto]"
                key={workflow.id}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      className="text-sm font-semibold text-text no-underline hover:underline"
                      params={{ workflowId: workflow.id }}
                      search={{ view: 'builder' }}
                      to="/workflows/$workflowId/edit"
                    >
                      {workflow.name}
                    </Link>
                    <StatusBadge status={workflow.status} />
                    <Badge>v{workflow.currentVersion}</Badge>
                  </div>
                  <p className="mt-2 mb-0 max-w-2xl text-[13px] leading-5 text-text-secondary">
                    {workflow.description}
                  </p>
                  <p className="mt-2 mb-0 text-xs text-text-muted">
                    {workflow.owner} · Trigger: {workflow.trigger}
                  </p>
                  {latestRun ? (
                    <Link
                      className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-text no-underline hover:underline"
                      params={{ runId: latestRun.id, workflowId: workflow.id }}
                      to="/workflows/$workflowId/runs/$runId"
                    >
                      Latest run <StatusBadge status={latestRun.status} />
                    </Link>
                  ) : (
                    <span className="mt-3 block text-xs text-text-muted">
                      No runs represented
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <Button
                    variant="secondary"
                    onClick={() =>
                      requestConnection(
                        `${workflow.status === 'enabled' ? 'Disable' : 'Enable'} ${workflow.name}`,
                      )
                    }
                  >
                    {workflow.status === 'enabled' ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    onClick={() => requestConnection(`Run ${workflow.name}`)}
                  >
                    <Play size={15} aria-hidden="true" />
                    Run
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
