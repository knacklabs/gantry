import { describe, expect, it } from 'vitest';

import { materializeMcpRecord } from '@core/application/mcp/mcp-server-materialization.js';

function recordWithTemplate(templateId: string | undefined) {
  return {
    definition: { name: 'github' },
    binding: { required: false },
    version: {
      config: { transport: 'stdio_template', templateId },
      credentialRefs: [],
      allowedToolPatterns: ['search'],
      autoApproveToolPatterns: [],
    },
  } as never;
}

describe('materializeMcpRecord', () => {
  it('throws a typed error for unsupported persisted stdio templates', () => {
    expect(() =>
      materializeMcpRecord(recordWithTemplate('removed-template'), {}),
    ).toThrow(/unsupported templateId/);
    try {
      materializeMcpRecord(recordWithTemplate(undefined), {});
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });
});
