import {
  listDeadLetterRuns,
  listJobRuns,
  listRecentJobEvents,
} from '../storage/db.js';
import { TaskHandler } from './ipc-task-types.js';

const schedulerListRunsHandler: TaskHandler = ({ data }) => {
  listJobRuns(undefined, typeof data.limit === 'number' ? data.limit : 50);
};

const schedulerListEventsHandler: TaskHandler = ({ data }) => {
  listRecentJobEvents(typeof data.limit === 'number' ? data.limit : 200, {
    job_id:
      typeof data.jobId === 'string' && data.jobId.trim().length > 0
        ? data.jobId.trim()
        : undefined,
    run_id:
      typeof data.runId === 'string' && data.runId.trim().length > 0
        ? data.runId.trim()
        : undefined,
    event_type:
      typeof data.eventType === 'string' && data.eventType.trim().length > 0
        ? data.eventType.trim()
        : undefined,
  });
};

const schedulerGetDeadLetterHandler: TaskHandler = ({ data }) => {
  listDeadLetterRuns(typeof data.limit === 'number' ? data.limit : 50);
};

export const schedulerQueryTaskHandlers: Record<string, TaskHandler> = {
  scheduler_list_runs: schedulerListRunsHandler,
  scheduler_list_events: schedulerListEventsHandler,
  scheduler_wait_for_events: schedulerListEventsHandler,
  scheduler_get_dead_letter: schedulerGetDeadLetterHandler,
};
