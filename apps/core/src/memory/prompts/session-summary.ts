export const SESSION_SUMMARY_PROMPT = `Summarize this agent session for future continuation.

Produce STRICT markdown with exactly these four sections in this order:

## Summary
<= 200 words, past tense, what was done and decided.

## Open loops
- bullet list of unresolved asks, blocked items, or "come back to this" commits.
- empty bullet \`- none\` if nothing unresolved.

## Decisions
- bullet list of non-obvious choices with their rationale.
- \`- none\` if no decisions this session.

## Files touched
- path — one-line change summary.
- \`- none\` if no files changed.

Do NOT include:
- ephemeral chatter, acknowledgements, or tool-output dumps
- speculation about what the user might want next
- marketing language or praise
- content that does not appear in the transcript

Quote file paths, identifiers, and decisions verbatim from the transcript. Never invent file paths or function names.`;
