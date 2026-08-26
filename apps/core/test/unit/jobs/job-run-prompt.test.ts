import { describe, expect, it } from 'vitest';

import { scheduledJobRunPrompt } from '@core/jobs/job-run-prompt.js';
import { MEMORY_DREAM_SYSTEM_PROMPT } from '@core/shared/system-job-identity.js';

const OUTCOME_PARAGRAPH =
  'When you are finished, your final message must begin with a line `Outcome: <one sentence stating what changed or was found, with counts and names>` (say so if nothing changed), followed by any details.';

describe('scheduledJobRunPrompt', () => {
  it('appends one trailing Outcome paragraph without duplicating it', () => {
    const prompt = scheduledJobRunPrompt({
      prompt: 'Summarize current status',
    });

    expect(prompt).toBe(`Summarize current status\n\n${OUTCOME_PARAGRAPH}`);
    expect(scheduledJobRunPrompt({ prompt })).toBe(prompt);
  });

  it('returns system job prompts unchanged', () => {
    expect(scheduledJobRunPrompt({ prompt: MEMORY_DREAM_SYSTEM_PROMPT })).toBe(
      MEMORY_DREAM_SYSTEM_PROMPT,
    );
  });

  it('normalizes trailing prompt whitespace', () => {
    expect(
      scheduledJobRunPrompt({ prompt: 'Summarize current status  \n\n' }),
    ).toBe(`Summarize current status\n\n${OUTCOME_PARAGRAPH}`);
  });
});
