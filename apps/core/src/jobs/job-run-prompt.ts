import type { Job } from '../domain/types.js';
import { MEMORY_DREAM_SYSTEM_PROMPT } from '../shared/system-job-identity.js';

const OUTCOME_PARAGRAPH =
  'When you are finished, your final message must begin with a line `Outcome: <one sentence stating what changed or was found, with counts and names>` (say so if nothing changed), followed by any details.';

export function scheduledJobRunPrompt(job: Pick<Job, 'prompt'>): string {
  if (job.prompt === MEMORY_DREAM_SYSTEM_PROMPT) return job.prompt;

  if (job.prompt.trimEnd().endsWith(OUTCOME_PARAGRAPH)) return job.prompt;

  const separator = job.prompt.endsWith('\n') ? '\n' : '\n\n';
  return `${job.prompt}${separator}${OUTCOME_PARAGRAPH}`;
}
