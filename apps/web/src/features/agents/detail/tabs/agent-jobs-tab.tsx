import { Link } from '@tanstack/react-router';

import { buttonVariants } from '../../../../ui/primitives/button';
import { StatusBadge } from '../../../../ui/compositions/status-badge';
import type { AgentWorkflowMap } from '../../agents-queries';

export function AgentJobsTab({ map }: { map: AgentWorkflowMap }) {
  const jobs = map.relationships.filter(
    (relationship) => relationship.kind === 'job',
  );
  return (
    <div className="p-5">
      <section className="overflow-hidden rounded-lg border border-border bg-surface">
        <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
          <div>
            <h2 className="m-0 text-sm font-semibold">Scheduled work</h2>
            <p className="mt-1 mb-0 text-xs text-text-secondary">
              Read-only jobs scoped to this AI employee.
            </p>
          </div>
          <Link
            className={buttonVariants({ size: 'sm', variant: 'outline' })}
            to="/jobs"
            search={{
              status: 'all',
              q: '',
              page: 1,
              sort: 'name',
              desc: false,
            }}
          >
            Manage jobs
          </Link>
        </header>
        {jobs.length ? (
          <ul className="m-0 grid list-none divide-y divide-border p-0">
            {jobs.map((job) => (
              <li
                className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_auto_auto] sm:items-center"
                key={job.id}
              >
                <div>
                  <strong className="block text-sm">{job.name}</strong>
                  <span className="text-xs text-text-secondary">
                    {job.schedule}
                  </span>
                </div>
                <StatusBadge status={job.status} />
                <span className="font-mono text-caption text-text-muted">
                  {job.nextRun
                    ? `Next ${new Date(job.nextRun).toLocaleString()}`
                    : 'No next run'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 px-4 py-6 text-sm text-text-secondary">
            No jobs are configured for this AI employee.
          </p>
        )}
      </section>
    </div>
  );
}
