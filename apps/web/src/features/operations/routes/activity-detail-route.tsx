import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Activity,
  ArrowLeft,
  CircleOff,
  RefreshCw,
  SearchX,
  TriangleAlert,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import {
  activityDetailQuery,
  isTerminalActivityStatus,
  type UiActivityTask,
  UiApiError,
  uiApiErrorMessage,
} from '../../../lib/ui-api';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '../../../ui/primitives/alert';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';

type StreamState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'disconnected'
  | 'completed';

export function ActivityDetailRoute() {
  const { runId } = useParams({ from: '/activity/$runId' });
  const navigate = useNavigate({ from: '/activity/$runId' });
  const query = useQuery(activityDetailQuery(runId));
  const hasData = Boolean(query.data);
  const terminal = isTerminalActivityStatus(query.data?.run.status ?? '');
  const [visible, setVisible] = useState(
    () => document.visibilityState === 'visible',
  );
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [streamAttempt, setStreamAttempt] = useState(0);
  const cursor = useRef(0);
  const refreshTimer = useRef<number | undefined>(undefined);
  const reconnectTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const updateVisibility = () =>
      setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', updateVisibility);
    return () =>
      document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    if (terminal || !hasData) return;
    if (!visible) {
      setStreamState('disconnected');
      return;
    }

    setStreamState('connecting');
    const source = new EventSource(
      `/ui/api/activity/${encodeURIComponent(runId)}/events?afterEventId=${cursor.current}`,
    );
    source.onopen = () => setStreamState('live');
    source.onmessage = (event) => {
      try {
        const invalidation = JSON.parse(event.data) as { eventId?: unknown };
        if (
          typeof invalidation.eventId === 'number' &&
          Number.isSafeInteger(invalidation.eventId) &&
          invalidation.eventId >= 0
        ) {
          cursor.current = Math.max(cursor.current, invalidation.eventId);
        }
      } catch {
        return;
      }
      if (refreshTimer.current !== undefined) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = undefined;
        void query.refetch({ cancelRefetch: false });
      }, 1_000);
    };
    source.onerror = () => {
      source.close();
      setStreamState('reconnecting');
      if (reconnectTimer.current !== undefined) return;
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = undefined;
        setStreamAttempt((attempt) => attempt + 1);
      }, 1_000);
    };

    return () => {
      source.close();
      if (refreshTimer.current !== undefined) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = undefined;
      }
      if (reconnectTimer.current !== undefined) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = undefined;
      }
    };
  }, [hasData, query.refetch, runId, streamAttempt, terminal, visible]);

  if (query.isPending) {
    return (
      <PageState
        description="Reading this run and its task tree from Gantry."
        icon={<Activity aria-hidden="true" />}
        kind="loading"
        title="Loading run"
      />
    );
  }

  if (!query.data) {
    const missing =
      query.error instanceof UiApiError && query.error.code === 'RUN_NOT_FOUND';
    return (
      <PageState
        action={
          missing ? (
            <Button
              variant="secondary"
              onClick={() =>
                void navigate({
                  to: '/activity',
                  search: { outcome: 'all', page: 1, q: '', type: 'all' },
                })
              }
            >
              Back to activity
            </Button>
          ) : (
            <Button onClick={() => void query.refetch()}>Retry</Button>
          )
        }
        description={uiApiErrorMessage(query.error)}
        icon={
          missing ? (
            <SearchX aria-hidden="true" />
          ) : (
            <CircleOff aria-hidden="true" />
          )
        }
        kind={missing ? 'empty' : 'offline'}
        title={missing ? 'Run not found' : 'Run is unavailable'}
      />
    );
  }

  const { run, tasks, taskTotal, truncated } = query.data;
  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        search={{ outcome: 'all', page: 1, q: '', type: 'all' }}
        to="/activity"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Live activity
      </Link>
      <PageHeader
        eyebrow={`Agent run · ${formatLabel(run.cause)}`}
        title={run.id}
        description={`Started ${formatTimestamp(run.startedAt ?? run.createdAt)} · ${formatDuration(run.durationMs)}`}
        action={
          <div className="flex items-center gap-2" aria-live="polite">
            <StatusBadge status={run.status} />
            <StatusBadge status={terminal ? 'completed' : streamState} />
            <Button
              disabled={query.isFetching}
              variant="secondary"
              onClick={() => void query.refetch({ cancelRefetch: false })}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {query.isFetching ? 'Refreshing' : 'Refresh'}
            </Button>
          </div>
        }
      />

      {query.isError ? (
        <Alert className="border-status-attention/50 bg-status-attention-soft">
          <RefreshCw aria-hidden="true" />
          <AlertTitle>Showing the last successful activity</AlertTitle>
          <AlertDescription>
            {uiApiErrorMessage(query.error)} Live updates will keep retrying
            while this tab is visible.
          </AlertDescription>
        </Alert>
      ) : null}

      {truncated ? (
        <Alert className="border-status-attention/50 bg-status-attention-soft">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Task tree truncated</AlertTitle>
          <AlertDescription>
            Showing the first 100 of {taskTotal} tasks for this run.
          </AlertDescription>
        </Alert>
      ) : null}

      <Panel title="Root run" description={`Owned by ${run.agentId}`}>
        <dl className="m-0 grid gap-px bg-border sm:grid-cols-2">
          <RunDetail label="Agent" value={run.agentId} mono />
          <RunDetail label="Status" value={formatLabel(run.status)} />
          <RunDetail label="Created" value={formatTimestamp(run.createdAt)} />
          <RunDetail
            label="Started"
            value={formatOptionalTimestamp(run.startedAt)}
          />
          <RunDetail
            label="Ended"
            value={formatOptionalTimestamp(run.endedAt)}
          />
          <RunDetail label="Duration" value={formatDuration(run.durationMs)} />
          <RunDetail
            label="Result summary"
            value={run.resultSummary ?? 'Not reported'}
          />
          <RunDetail label="Error summary" value={run.errorSummary ?? 'None'} />
        </dl>
      </Panel>

      <Panel
        title="Task tree"
        description={`${taskTotal} child task${taskTotal === 1 ? '' : 's'} recorded`}
      >
        {tasks.length ? (
          <TaskTree tasks={tasks} />
        ) : (
          <p className="m-0 p-6 text-sm text-text-secondary">
            This run has no child tasks.
          </p>
        )}
      </Panel>
    </div>
  );
}

function TaskTree({ tasks }: { tasks: UiActivityTask[] }) {
  const firstTaskId = tasks[0]?.id;
  return (
    <ul
      aria-label="Run task tree"
      className="m-0 list-none p-0"
      role="tree"
      onFocus={(event) => {
        const tree = event.currentTarget;
        tree
          .querySelectorAll<HTMLElement>('[role="treeitem"]')
          .forEach((item) => (item.tabIndex = item === event.target ? 0 : -1));
      }}
      onKeyDown={handleTreeKeyDown}
    >
      {tasks.map((task) => (
        <TaskTreeItem
          firstTaskId={firstTaskId}
          key={task.id}
          level={1}
          task={task}
        />
      ))}
    </ul>
  );
}

function TaskTreeItem({
  firstTaskId,
  level,
  task,
}: {
  firstTaskId?: string;
  level: number;
  task: UiActivityTask;
}) {
  const summaries = [
    ['Summary', task.summary],
    ['Output', task.outputSummary],
    ['Error', task.errorSummary],
    ['Last tool', task.lastToolSummary],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return (
    <li
      aria-level={level}
      aria-expanded={task.children.length ? true : undefined}
      className="border-b border-border last:border-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      role="treeitem"
      tabIndex={task.id === firstTaskId ? 0 : -1}
    >
      <article
        className="grid gap-4 p-4"
        style={{ paddingInlineStart: `${Math.min(level, 6) * 16}px` }}
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <strong className="block truncate font-mono text-xs text-text">
              {task.id}
            </strong>
            <span className="mt-1 block text-xs text-text-secondary">
              {task.targetAgentId
                ? `${task.agentId} → ${task.targetAgentId}`
                : task.agentId}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge>{formatLabel(task.kind)}</Badge>
            <StatusBadge status={task.status} />
          </div>
        </div>
        <dl className="m-0 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <TaskDetail label="Agent" value={task.agentId} />
          <TaskDetail
            label="Target agent"
            value={task.targetAgentId ?? 'None'}
          />
          <TaskDetail
            label="Phase"
            value={task.currentPhase ?? 'Not reported'}
          />
          <TaskDetail
            label="Progress"
            value={task.lastProgress ?? 'Not reported'}
          />
          <TaskDetail label="Blocker" value={task.blocker ?? 'None'} />
          {summaries.map(([label, value]) => (
            <TaskDetail key={label} label={label} value={value} />
          ))}
          <TaskDetail label="Created" value={formatTimestamp(task.createdAt)} />
          <TaskDetail label="Updated" value={formatTimestamp(task.updatedAt)} />
          <TaskDetail
            label="Started"
            value={formatOptionalTimestamp(task.startedAt)}
          />
          <TaskDetail
            label="Finished"
            value={formatOptionalTimestamp(task.terminalAt)}
          />
          <TaskDetail
            label="Duration"
            value={formatDuration(task.durationMs)}
          />
        </dl>
      </article>
      {task.children.length ? (
        <ul className="m-0 list-none border-t border-border p-0" role="group">
          {task.children.map((child) => (
            <TaskTreeItem
              firstTaskId={firstTaskId}
              key={child.id}
              level={level + 1}
              task={child}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function handleTreeKeyDown(event: KeyboardEvent<HTMLUListElement>) {
  const current = (event.target as HTMLElement).closest<HTMLElement>(
    '[role="treeitem"]',
  );
  if (!current) return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  );
  const index = items.indexOf(current);
  const level = Number(current.getAttribute('aria-level'));
  let next: HTMLElement | undefined;
  if (event.key === 'ArrowDown') next = items[index + 1];
  if (event.key === 'ArrowUp') next = items[index - 1];
  if (event.key === 'Home') next = items[0];
  if (event.key === 'End') next = items.at(-1);
  if (
    event.key === 'ArrowRight' &&
    Number(items[index + 1]?.getAttribute('aria-level')) > level
  ) {
    next = items[index + 1];
  }
  if (event.key === 'ArrowLeft' && level > 1) {
    next = items
      .slice(0, index)
      .reverse()
      .find((item) => Number(item.getAttribute('aria-level')) === level - 1);
  }
  if (!next) return;
  event.preventDefault();
  items.forEach((item) => (item.tabIndex = item === next ? 0 : -1));
  next.focus();
}

function RunDetail({
  label,
  mono,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className="grid gap-1 bg-surface p-4 text-[13px]">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd
        className={`m-0 break-words text-text ${mono ? 'font-mono text-xs' : 'font-medium'}`}
      >
        {value}
      </dd>
    </div>
  );
}

function TaskDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="mt-0.5 ml-0 break-words leading-5 text-text-secondary">
        {value}
      </dd>
    </div>
  );
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

function formatOptionalTimestamp(value: string | null) {
  return value ? formatTimestamp(value) : 'Not yet';
}

function formatDuration(durationMs: number | null) {
  if (durationMs === null) return 'In progress';
  if (durationMs < 1_000) return `${durationMs} ms`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatLabel(value: string) {
  return value
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}
