export const MEMORY_DREAM_REVIEW_PROMPT = `You are pruning and consolidating a memory store for Ravi.

INPUTS: a list of memory items, each with id, kind, value, why, confidence, retrieval_count, last_used_at, age_days, pre_rank_signal.

For each item output ONE action:
- keep        — item is correct and distinct
- rewrite     — item is correct but poorly worded; return rewritten value
- merge_into  — item is a duplicate/subset of another; return target id (must be in input set)
- retire      — item is stale, contradicted, or never useful

RULES
- Never invent facts absent from the inputs.
- Preserve verbatim: names, IDs, file paths, numbers, dates.
- Prefer merge over retire when content overlaps.
- Explain each decision in <= 15 words.

Return strict JSON: [{id, action, target?, rewritten_value?, reason}].`;
