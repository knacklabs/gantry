import {
  CheckCircle2,
  Clock3,
  LoaderCircle,
  Pencil,
  Trash2,
  TriangleAlert,
  XCircle,
} from 'lucide-react';

import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import type { JobView, RunEventView, RunView } from '../job-api';

export function JobSidebar({
  job,
  runs,
  selectedRunId,
  onSelectRun,
  onEdit,
  onDelete,
  deleting,
}: {
  job: JobView;
  runs: RunView[];
  selectedRunId?: string;
  onSelectRun: (runId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div className="grid content-start gap-4">
      <Panel title="Definition">
        <dl className="m-0 grid gap-3 p-4 text-[13px]">
          <Detail label="Schedule" value={job.schedule} />
          <Detail label="Next run" value={job.nextRun} />
          <Detail label="Agent" value={job.agent} />
          <Detail
            label="Notifications"
            value={job.notificationRoutes.join(', ') || 'None'}
          />
        </dl>
        <div className="flex gap-2 border-t border-border p-3">
          <Button size="sm" onClick={onEdit}>
            <Pencil size={14} aria-hidden="true" /> Edit
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={deleting}
            onClick={onDelete}
          >
            <Trash2 size={14} aria-hidden="true" /> Delete
          </Button>
        </div>
      </Panel>
      <Panel title="Recent runs" description={`${runs.length} runs`}>
        <div className="divide-y divide-border">
          {runs.map((run) => (
            <button
              aria-pressed={selectedRunId === run.id}
              className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 text-left hover:bg-surface-muted ${selectedRunId === run.id ? 'bg-surface-strong' : 'bg-transparent'}`}
              key={run.id}
              type="button"
              onClick={() => onSelectRun(run.id)}
            >
              <span>
                <strong className="block text-[13px] text-text">
                  {run.startedAt}
                </strong>
                <span className="text-xs text-text-muted">{run.duration}</span>
              </span>
              <StatusBadge status={run.status} />
            </button>
          ))}
          {runs.length === 0 ? (
            <p className="m-0 p-4 text-xs text-text-secondary">
              No recent runs.
            </p>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

export function RunPanel({
  selectedRunId,
  run,
  events,
  loading,
  error,
}: {
  selectedRunId?: string;
  run?: RunView;
  events: RunEventView[];
  loading: boolean;
  error?: string;
}) {
  if (!selectedRunId) {
    return (
      <PageState
        description="Trigger this job to create its first run."
        icon={<Clock3 size={18} aria-hidden="true" />}
        kind="empty"
        title="No run selected"
      />
    );
  }
  if (loading) {
    return (
      <PageState
        description="Loading run state and safe events."
        icon={
          <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />
        }
        kind="loading"
        title="Loading run"
      />
    );
  }
  if (error || !run) {
    return (
      <PageState
        description={error ?? 'Run not found.'}
        icon={<TriangleAlert size={18} aria-hidden="true" />}
        kind="error"
        title="Run could not be loaded"
      />
    );
  }
  return (
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
        <section>
          <h2 className="m-0 text-xs font-semibold text-text">
            Safe event timeline
          </h2>
          <div className="mt-3 grid gap-4">
            {events.map((event) => (
              <TimelineRow key={event.id} event={event} />
            ))}
            {events.length === 0 ? (
              <p className="m-0 text-xs text-text-secondary">
                No events recorded.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </Panel>
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

function TimelineRow({ event }: { event: RunEventView }) {
  const Icon =
    event.status === 'done'
      ? CheckCircle2
      : event.status === 'failed'
        ? XCircle
        : Clock3;
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)_auto] gap-3">
      <Icon
        className={
          event.status === 'done'
            ? 'text-status-success'
            : event.status === 'failed'
              ? 'text-danger'
              : 'text-status-attention'
        }
        size={16}
        aria-hidden="true"
      />
      <strong className="text-[13px] text-text">{event.label}</strong>
      <span className="font-mono text-[10px] text-text-muted">
        {event.time}
      </span>
    </div>
  );
}
