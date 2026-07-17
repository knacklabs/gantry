import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowLeft,
  LoaderCircle,
  Pause,
  Play,
  SearchX,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import { useState } from 'react';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import { EditJobDialog } from '../components/edit-job-dialog';
import { JobSidebar, RunPanel } from '../components/job-detail-panels';
import {
  useDeleteJob,
  useJob,
  useJobAction,
  useJobRuns,
  useRunDetail,
} from '../use-jobs';

const jobsSearch = {
  q: '',
  status: 'all' as const,
  page: 1,
  sort: 'name' as const,
  desc: false,
};

export function JobDetailRoute() {
  const { jobId } = useParams({ from: '/jobs/$jobId' });
  const search = useSearch({ from: '/jobs/$jobId' });
  const navigate = useNavigate({ from: '/jobs/$jobId' });
  const connection = useRuntimeConnection();
  const jobQuery = useJob(jobId);
  const runsQuery = useJobRuns(jobId);
  const selectedRunId = search.run ?? runsQuery.data?.[0]?.id;
  const runQuery = useRunDetail(selectedRunId);
  const [editOpen, setEditOpen] = useState(false);
  const actions = useJobAction(jobId);
  const deletion = useDeleteJob(jobId);

  const back = (
    <Link
      className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
      search={jobsSearch}
      to="/jobs"
    >
      <ArrowLeft size={15} aria-hidden="true" /> Jobs
    </Link>
  );

  if (!connection.transport) {
    return (
      <div className="mx-auto grid w-full max-w-[1180px] gap-6">
        {back}
        <PageState
          description="Start Gantry with local-owner UI linkage to inspect this job."
          icon={<WifiOff size={18} aria-hidden="true" />}
          kind="offline"
          title="Runtime not connected"
        />
      </div>
    );
  }
  if (jobQuery.isPending || runsQuery.isPending) {
    return (
      <PageState
        description="Loading definition and recent runs."
        icon={
          <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />
        }
        kind="loading"
        title="Loading job"
      />
    );
  }
  if (jobQuery.isError || runsQuery.isError) {
    return (
      <PageState
        description={
          (jobQuery.error ?? runsQuery.error)?.message ?? 'Request failed.'
        }
        icon={<TriangleAlert size={18} aria-hidden="true" />}
        kind="error"
        title="Job could not be loaded"
      />
    );
  }
  if (!jobQuery.data) {
    return (
      <PageState
        description="The runtime does not contain this job."
        icon={<SearchX size={18} aria-hidden="true" />}
        kind="empty"
        title="Job not found"
      />
    );
  }

  async function removeJob() {
    if (
      !window.confirm(
        `Delete ${jobQuery.data?.name}? This removes its schedule.`,
      )
    )
      return;
    try {
      await deletion.mutateAsync();
      await navigate({ to: '/jobs', search: jobsSearch });
    } catch {
      // TanStack Mutation exposes the sanitized server error below.
    }
  }

  const job = jobQuery.data;
  return (
    <div className="mx-auto grid w-full max-w-[1180px] gap-6">
      {back}
      <PageHeader
        eyebrow="Scheduled job"
        title={job.name}
        description={`${job.description} · ${job.agent}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={job.status} />
            <Button
              disabled={actions.isPending}
              onClick={() =>
                actions.mutate(
                  job.canonicalStatus === 'paused' ? 'resume' : 'pause',
                )
              }
            >
              {job.canonicalStatus === 'paused' ? (
                <Play size={15} aria-hidden="true" />
              ) : (
                <Pause size={15} aria-hidden="true" />
              )}
              {job.canonicalStatus === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button
              disabled={actions.isPending}
              onClick={() => actions.mutate('trigger')}
            >
              <Play size={15} aria-hidden="true" /> Run now
            </Button>
          </div>
        }
      />
      {actions.error || deletion.error ? (
        <p
          className="m-0 rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger"
          role="alert"
        >
          {(actions.error ?? deletion.error)?.message}
        </p>
      ) : null}
      {job.blocker ? (
        <div className="rounded-md border border-danger/40 bg-danger-soft p-4">
          <strong className="block text-[13px] text-danger">
            Job is blocked
          </strong>
          <span className="mt-1 block text-xs text-danger">
            {job.blocker.summary}
          </span>
          <span className="mt-2 block font-mono text-[11px] text-danger">
            Next action: {job.blocker.action}
          </span>
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <JobSidebar
          job={job}
          runs={runsQuery.data ?? []}
          selectedRunId={selectedRunId}
          onSelectRun={(run) => void navigate({ search: { run } })}
          onEdit={() => setEditOpen(true)}
          onDelete={() => void removeJob()}
          deleting={deletion.isPending}
        />
        <RunPanel
          selectedRunId={selectedRunId}
          run={runQuery.data?.run}
          events={runQuery.data?.events ?? []}
          loading={runQuery.isPending}
          error={runQuery.error?.message}
        />
      </div>
      <EditJobDialog job={job} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}
