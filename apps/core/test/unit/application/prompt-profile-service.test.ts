import { describe, expect, it } from 'vitest';

import { PromptProfileService } from '@core/application/agents/prompt-profile-service.js';

describe('prompt-profile-service', () => {
  it('compiled full-access prompt instructs declaring job tool requirements', async () => {
    const prompt = await new PromptProfileService().compileSystemPrompt({
      agentFolder: 'job-creator',
      accessPreset: 'full',
    });

    expect(prompt).toContain(
      'When creating a scheduled job, declare every tool the task will need in scheduler_upsert_job access_requirements at creation. Prefer reviewed semantic-capability IDs',
    );
  });
});
