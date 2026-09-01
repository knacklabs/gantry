import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function modelVisibleExternalCapabilityResult(
  message: string | undefined,
  data: unknown,
): CallToolResult {
  if (
    data !== null &&
    typeof data === 'object' &&
    'status' in data &&
    data.status === 'accepted'
  ) {
    return {
      content: [
        {
          type: 'text',
          text:
            message || 'External capability accepted; this job is suspending.',
        },
      ],
    };
  }
  if (data !== undefined) {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
    };
  }
  return {
    content: [
      {
        type: 'text',
        text:
          message || 'External capability accepted; this job is suspending.',
      },
    ],
  };
}
