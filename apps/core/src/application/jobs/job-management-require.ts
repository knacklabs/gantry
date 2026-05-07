import { ApplicationError } from '../common/application-error.js';
import type {
  JobControlPort,
  JobManagementServiceDeps,
  JobTriggerQueuePort,
  RuntimeEventPublisherPort,
} from './job-management-types.js';

export function requireJobControl(
  deps: JobManagementServiceDeps,
): JobControlPort {
  if (!deps.control) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Job control repository unavailable',
    );
  }
  return deps.control;
}

export function requireRuntimeEvents(
  deps: JobManagementServiceDeps,
): RuntimeEventPublisherPort {
  if (!deps.runtimeEvents) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Runtime event publisher unavailable',
    );
  }
  return deps.runtimeEvents;
}

export function requireTriggerQueue(
  deps: JobManagementServiceDeps,
): JobTriggerQueuePort {
  if (!deps.triggerQueue) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Scheduler trigger queue unavailable',
    );
  }
  return deps.triggerQueue;
}
