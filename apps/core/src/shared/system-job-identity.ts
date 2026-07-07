export const SYSTEM_JOB_PROMPT_PREFIX = '__system:';
export const SYSTEM_JOB_ID_PREFIX = 'system:';
export const MEMORY_DREAM_SYSTEM_PROMPT = '__system:memory_dream';
export const MEMORY_EMBEDDING_BACKFILL_SYSTEM_PROMPT =
  '__system:memory_embedding_backfill';
export const BRAIN_EMBEDDING_BACKFILL_SYSTEM_PROMPT =
  '__system:brain_embedding_backfill';
export const BRAIN_DREAM_SYSTEM_PROMPT = '__system:brain_dream';
export const MEMORY_DREAMING_JOB_ID_PREFIX = 'system:dreaming:';
export const MEMORY_EMBEDDING_BACKFILL_JOB_ID = 'system:embedding-backfill';
export const BRAIN_EMBEDDING_BACKFILL_JOB_ID =
  'system:brain-embedding-backfill';
export const BRAIN_DREAMING_JOB_ID = 'system:brain-dreaming';

export function isReservedSystemJobPrompt(prompt: string): boolean {
  return prompt.trim().startsWith(SYSTEM_JOB_PROMPT_PREFIX);
}

export function isReservedSystemJobId(jobId: string): boolean {
  return jobId.trim().startsWith(SYSTEM_JOB_ID_PREFIX);
}

export function isTrustedSystemJob(job: {
  id: string;
  prompt: string;
}): boolean {
  if (
    job.id === MEMORY_EMBEDDING_BACKFILL_JOB_ID &&
    job.prompt === MEMORY_EMBEDDING_BACKFILL_SYSTEM_PROMPT
  ) {
    return true;
  }
  if (
    job.id === BRAIN_EMBEDDING_BACKFILL_JOB_ID &&
    job.prompt === BRAIN_EMBEDDING_BACKFILL_SYSTEM_PROMPT
  ) {
    return true;
  }
  if (
    job.id === BRAIN_DREAMING_JOB_ID &&
    job.prompt === BRAIN_DREAM_SYSTEM_PROMPT
  ) {
    return true;
  }
  return (
    job.id.startsWith(MEMORY_DREAMING_JOB_ID_PREFIX) &&
    job.prompt === MEMORY_DREAM_SYSTEM_PROMPT
  );
}

export function isMemoryDreamingSystemJob(job: {
  id: string;
  prompt: string;
}): boolean {
  return (
    job.id.startsWith(MEMORY_DREAMING_JOB_ID_PREFIX) &&
    job.prompt === MEMORY_DREAM_SYSTEM_PROMPT
  );
}
