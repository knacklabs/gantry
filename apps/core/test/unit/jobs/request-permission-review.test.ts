import { describe, expect, it, vi } from 'vitest';

import {
  persistRequestPermissionRules,
  requestPermissionReviewSuggestions,
} from '@core/jobs/request-permission-review.js';

describe('request permission review helpers', () => {
  it('does not suggest persistent tool grants for temporary, non-tool, multi-tool, or oversized rules', () => {
    expect(
      requestPermissionReviewSuggestions({
        temporaryOnly: true,
        toolName: 'Bash',
      }),
    ).toBeUndefined();
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'provider_capability',
        toolName: 'Bash',
      }),
    ).toBeUndefined();
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolNames: ['Bash', 'Write'],
      }),
    ).toBeUndefined();
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'x'.repeat(2049),
      }),
    ).toBeUndefined();
  });

  it('stores synthetic permission tools under namespaced ids without widening oversized rules', async () => {
    const repository = {
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
    };

    const persisted = await persistRequestPermissionRules({
      deps: { getToolRepository: () => repository as never },
      sourceGroup: 'agent:one',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash' }],
        },
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            {
              toolName: 'Write',
              ruleContent: 'x'.repeat(2049),
            },
          ],
        },
      ],
    });

    expect(persisted).toEqual(['Bash']);
    expect(repository.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^tool:permission-rule:/),
        name: 'Bash',
      }),
    );
    expect(repository.saveTool.mock.calls[0]?.[0].id).not.toBe('tool:Bash');
  });
});
