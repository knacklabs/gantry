import { describe, expect, it } from 'vitest';

import {
  JobPrimingService,
  type CollectedPrimeToolAttempt,
} from '@core/jobs/job-priming-service.js';

describe('JobPrimingService', () => {
  it('formats collected prime attempts into permission suggestions', () => {
    const service = new JobPrimingService();
    const attempts: CollectedPrimeToolAttempt[] = [
      {
        requestedToolName: 'Bash',
        toolName: 'Bash',
        toolInput: { cmd: 'npm test --runInBand' },
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [
              {
                toolName: 'Bash',
                ruleContent: 'npm test --runInBand',
              },
            ],
          },
        ],
      },
      {
        requestedToolName: 'mcp__myclaw__browser_act',
        toolName: 'Browser',
        toolInput: { url: 'https://example.com' },
      },
    ];

    expect(service.formatPermissionSuggestions(attempts)).toEqual([
      {
        requestedToolName: 'Bash',
        toolName: 'Bash',
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [
              {
                toolName: 'Bash',
                ruleContent: 'npm test --runInBand',
              },
            ],
          },
        ],
      },
      {
        requestedToolName: 'mcp__myclaw__browser_act',
        toolName: 'Browser',
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Browser' }],
          },
        ],
      },
    ]);
  });
});
