import type { Job } from '../../domain/types.js';
import { ApplicationError } from '../common/application-error.js';

export function jobBelongsToApp(job: Job, appId: string): boolean {
  return (Array.isArray(job.linked_sessions) ? job.linked_sessions : []).some(
    (chatJid) => {
      if (!chatJid.startsWith('app:')) return false;
      const rest = chatJid.slice('app:'.length);
      const delimiterIndex = rest.indexOf(':');
      if (delimiterIndex <= 0 || rest.indexOf(':', delimiterIndex + 1) !== -1) {
        return false;
      }
      return rest.slice(0, delimiterIndex) === appId;
    },
  );
}

export function assertJobBelongsToApp(job: Job, appId: string): void {
  if (!jobBelongsToApp(job, appId)) {
    throw new ApplicationError('FORBIDDEN', 'API key cannot access this job');
  }
}
