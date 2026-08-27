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

  it('appends the Outcome paragraph when a copied occurrence is followed by instructions', () => {
    const prompt = `First follow this copied guidance: ${OUTCOME_PARAGRAPH}\nThen summarize the changes.`;

    expect(scheduledJobRunPrompt({ prompt })).toBe(
      `${prompt}\n\n${OUTCOME_PARAGRAPH}`,
    );
  });

  it('returns a prompt ending with the Outcome paragraph and trailing whitespace unchanged', () => {
    const prompt = `Summarize current status\n\n${OUTCOME_PARAGRAPH}  \n\n`;

    expect(scheduledJobRunPrompt({ prompt })).toBe(prompt);
  });

  it('preserves user trailing whitespace before appending the Outcome paragraph', () => {
    const prompt = 'Summarize current status  ';
    const result = scheduledJobRunPrompt({ prompt });

    expect(result.startsWith(prompt)).toBe(true);
    expect(result).toBe(`${prompt}\n\n${OUTCOME_PARAGRAPH}`);
  });
});
