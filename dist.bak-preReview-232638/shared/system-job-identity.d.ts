export declare const SYSTEM_JOB_PROMPT_PREFIX = "__system:";
export declare const SYSTEM_JOB_ID_PREFIX = "system:";
export declare const MEMORY_DREAM_SYSTEM_PROMPT = "__system:memory_dream";
export declare const MEMORY_EMBEDDING_BACKFILL_SYSTEM_PROMPT = "__system:memory_embedding_backfill";
export declare const BRAIN_EMBEDDING_BACKFILL_SYSTEM_PROMPT = "__system:brain_embedding_backfill";
export declare const BRAIN_DREAM_SYSTEM_PROMPT = "__system:brain_dream";
export declare const OBSERVER_DIGEST_SYSTEM_PROMPT = "__system:observer_digest";
export declare const MEMORY_DREAMING_JOB_ID_PREFIX = "system:dreaming:";
export declare const OBSERVER_DIGEST_JOB_ID_PREFIX = "system:observer-digest:";
export declare const MEMORY_EMBEDDING_BACKFILL_JOB_ID = "system:embedding-backfill";
export declare const BRAIN_EMBEDDING_BACKFILL_JOB_ID = "system:brain-embedding-backfill";
export declare const BRAIN_DREAMING_JOB_ID = "system:brain-dreaming";
export declare function isReservedSystemJobPrompt(prompt: string): boolean;
export declare function isReservedSystemJobId(jobId: string): boolean;
export declare function isTrustedSystemJob(job: {
    id: string;
    prompt: string;
}): boolean;
export declare function isMemoryDreamingSystemJob(job: {
    id: string;
    prompt: string;
}): boolean;
