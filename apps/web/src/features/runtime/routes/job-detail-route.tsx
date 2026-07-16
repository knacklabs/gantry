import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  FileText,
  Pause,
  Play,
  RotateCcw,
  SearchX,
  XCircle,
} from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { ResultReceipt } from '../../../ui/compositions/result-receipt';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { jobPreviewQuery, runPreviewQuery } from '../runtime-queries';

export function JobDetailRoute() {
  const { jobId } = useParams({ from: '/jobs/$jobId' });
  const search = useSearch({ from: '/jobs/$jobId' });
  const navigate = useNavigate({ from: '/jobs/$jobId' });
  const { data: jobs } = useQuery(jobPreviewQuery);
  const { data: allRuns } = useQuery(runPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const job = jobs.find((item) => item.id === jobId);

  if (!job) {
    return (
      <PageState
        kind="empty"
        icon={<SearchX size={18} aria-hidden="true" />}
        title="Job not found"
        description="This preview snapshot does not contain that job."
      />
    );
  }

  const jobRuns = job.recentRunIds
    .map((id) => allRuns.find((run) => run.id === id))
    .filter((run) => run !== undefined);
  const run = jobRuns.find((item) => item.id === search.run) ?? jobRuns[0];

  return (
    <div className="mx-auto grid w-full max-w-[1180px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        search={{ q: '', status: 'all', page: 1, sort: 'name', desc: false }}
        to="/jobs"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Jobs
      </Link>
      <PageHeader
        eyebrow="Scheduled job"
        title={job.name}
        description={`${job.description} · ${job.agent}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={job.status} />
            <Button
              variant="secondary"
              onClick={() =>
                requestConnection(
                  `${job.status === 'paused' ? 'Resume' : 'Pause'} ${job.name}`,
                )
              }
            >
              {job.status === 'paused' ? (
                <Play size={15} aria-hidden="true" />
              ) : (
                <Pause size={15} aria-hidden="true" />
              )}
              {job.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button onClick={() => requestConnection(`Trigger ${job.name}`)}>
              <Play size={15} aria-hidden="true" />
              Run now
            </Button>
          </div>
        }
      />

      {job.blocker ? (
        <div className="flex flex-col gap-3 rounded-md border border-danger/40 bg-danger-soft p-4 sm:flex-row sm:items-center sm:justify-between">
          <span>
            <strong className="block text-[13px] text-danger">
              Job is blocked
            </strong>
            <span className="mt-1 block text-xs text-danger">
              {job.blocker.summary}
            </span>
          </span>
          <Button
            variant="secondary"
            onClick={() => requestConnection(job.blocker!.action)}
          >
            {job.blocker.action}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <Panel title="Definition">
            <dl className="m-0 grid gap-3 p-4 text-[13px]">
              <Detail label="Schedule" value={job.schedule} />
              <Detail label="Next run" value={job.nextRun} />
              <Detail label="Agent" value={job.agent} />
              <Detail
                label="Notification routes"
                value={
                  job.notificationRoutes.length
                    ? job.notificationRoutes.join(', ')
                    : 'None'
                }
              />
            </dl>
          </Panel>
          <Panel
            title="Recent runs"
            description={`${jobRuns.length} represented runs`}
          >
            <div className="divide-y divide-border">
              {jobRuns.map((item) => (
                <button
                  aria-pressed={run?.id === item.id}
                  className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 text-left hover:bg-surface-muted ${run?.id === item.id ? 'bg-surface-strong' : 'bg-transparent'}`}
                  key={item.id}
                  type="button"
                  onClick={() => void navigate({ search: { run: item.id } })}
                >
                  <span>
                    <strong className="block text-[13px] text-text">
                      {item.startedAt}
                    </strong>
                    <span className="text-xs text-text-muted">
                      {item.duration}
                    </span>
                  </span>
                  <StatusBadge status={item.status} />
                </button>
              ))}
              {jobRuns.length === 0 ? (
                <p className="m-0 p-4 text-xs text-text-secondary">
                  No recent runs.
                </p>
              ) : null}
            </div>
          </Panel>
        </div>

        {run ? (
          <Panel
            title="Run detail"
            description={run.id}
            action={<StatusBadge status={run.status} />}
          >
            <div className="grid gap-5 p-5">
              <section>
                <h2 className="m-0 text-xs font-semibold text-text">Outcome</h2>
                <p className="mt-2 mb-0 text-sm leading-6 text-text-secondary">
                  {run.outcome}
                </p>
              </section>
              {run.blocker ? (
                <div className="rounded-md border border-danger/40 bg-danger-soft p-3 text-xs text-danger">
                  {run.blocker.summary}
                </div>
              ) : null}
              <section>
                <h2 className="m-0 text-xs font-semibold text-text">
                  Timeline
                </h2>
                <div className="mt-3 grid gap-4">
                  {run.timeline.map((event) => (
                    <TimelineRow
                      key={`${event.time}-${event.label}`}
                      {...event}
                    />
                  ))}
                </div>
              </section>
              {run.files.length ? (
                <section>
                  <h2 className="m-0 text-xs font-semibold text-text">Files</h2>
                  <div className="mt-3 grid gap-2">
                    {run.files.map((file) => (
                      <button
                        className="flex min-h-12 items-center justify-between rounded-md border border-border px-3 text-left"
                        key={file.name}
                        type="button"
                        onClick={() =>
                          requestConnection(`Download ${file.name}`)
                        }
                      >
                        <span className="inline-flex items-center gap-2 text-[13px] text-text">
                          <FileText size={15} aria-hidden="true" />
                          {file.name}
                        </span>
                        <Badge>{file.size}</Badge>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="rounded-md border border-border p-4">
                <h2 className="mt-0 mb-3 text-xs font-semibold text-text">
                  Result receipt
                </h2>
                <ResultReceipt
                  attention={run.receipt.attention}
                  changed={run.receipt.changed}
                  completed={run.outcome}
                  delegated={run.receipt.delegated}
                  used={run.receipt.used}
                />
              </section>
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <Button
                  variant="secondary"
                  onClick={() => requestConnection(`Retry ${run.id}`)}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  Retry
                </Button>
                <Button
                  variant="danger"
                  onClick={() => requestConnection(`Cancel ${run.id}`)}
                >
                  <XCircle size={15} aria-hidden="true" />
                  Cancel
                </Button>
              </div>
            </div>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-1 ml-0 text-text">{value}</dd>
    </div>
  );
}

function TimelineRow({
  label,
  detail,
  time,
  status,
}: {
  label: string;
  detail: string;
  time: string;
  status: 'done' | 'active' | 'failed';
}) {
  const Icon =
    status === 'done' ? CheckCircle2 : status === 'failed' ? XCircle : Clock3;
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)_auto] gap-3">
      <Icon
        className={
          status === 'done'
            ? 'text-status-success'
            : status === 'failed'
              ? 'text-danger'
              : 'text-status-attention'
        }
        size={16}
        aria-hidden="true"
      />
      <span>
        <strong className="block text-[13px] text-text">{label}</strong>
        <span className="text-xs leading-5 text-text-secondary">{detail}</span>
      </span>
      <span className="font-mono text-[10px] text-text-muted">{time}</span>
    </div>
  );
}
