import { describe, expect, it } from 'vitest';
import { JobAgentTaskSchema } from '../../src/jobs/agent-task.js';

describe('caller tool transport contract', () => {
  const config = {
    tools: [
      {
        name: 'submit_result',
        description: 'Submit',
        inputSchema: { type: 'object' },
      },
    ],
    maxInteractions: 3,
    interactionTimeoutMs: 90000,
  };
  it('preserves legacy unspecified modes and both explicit supported modes', () => {
    const schema = JobAgentTaskSchema.shape.callerResolvedTools;
    expect(schema.parse(config)?.tools[0]).not.toHaveProperty('transportMode');
    for (const transportMode of ['direct_caller', 'checkpoint_atomic']) {
      expect(
        schema.parse({
          ...config,
          tools: [{ ...config.tools[0], transportMode }],
        })?.tools[0]?.transportMode,
      ).toBe(transportMode);
    }
  });
  it('rejects unknown modes instead of granting a direct tool', () => {
    expect(() =>
      JobAgentTaskSchema.shape.callerResolvedTools.parse({
        ...config,
        tools: [{ ...config.tools[0], transportMode: 'unsafe' }],
      }),
    ).toThrow();
  });
});
