import { describe, expect, it } from 'vitest';

import {
  projectMcpEvidence,
  summarizeMcpToolArguments,
} from '../../src/application/mcp/mcp-tool-audit.js';

describe('MCP tool audit projection', () => {
  it('projects a bounded operation discriminator without argument values', () => {
    expect(
      summarizeMcpToolArguments({
        operation: 'recipe.compile',
        payload: { captchaAnswer: 'never-project-me' },
      }),
    ).toMatchObject({
      keys: ['operation', 'payload'],
      discriminators: { operation: 'recipe.compile' },
    });
    expect(
      summarizeMcpToolArguments({ operation: 'secret value with spaces' }),
    ).not.toHaveProperty('discriminators');
  });

  it('projects evidence references but excludes unrelated strings', () => {
    expect(
      projectMcpEvidence({
        checkpointRef: 'artifact://sha256/checkpoint',
        traceRef: 'artifact://sha256/trace',
        captchaAnswer: 'never-project-me',
      }),
    ).toEqual([
      { path: 'checkpointRef', value: 'artifact://sha256/checkpoint' },
      { path: 'traceRef', value: 'artifact://sha256/trace' },
    ]);
  });
});
