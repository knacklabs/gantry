import { describe, expect, it } from 'vitest';
import {
  SourceMessageSchema,
  AppendSourceMessageRequestSchema,
} from '@gantry/contracts';
import { hashSourceMessage } from '../../../../../packages/sdk/src/source-channel.js';

export const message = {
  sourceMessageId: 'M1',
  sourcePosition: '9007199254740993',
  authorId: 'person1',
  authorKind: 'human' as const,
  authorDisplayName: 'Alice',
  text: 'hello',
  createdAt: '2026-11-17T00:00:00.000Z',
  replyToSourceId: null,
  revisionId: 'R1',
  origin: 'human' as const,
  contentHash: '0'.repeat(64),
};
describe('source channel contract', () => {
  it('hashes immutable author and source content but not display names', () => {
    expect(hashSourceMessage(message)).toBe(
      hashSourceMessage({ ...message, authorDisplayName: 'Updated name' }),
    );
    expect(hashSourceMessage({ ...message, authorId: 'person2' })).not.toBe(
      hashSourceMessage(message),
    );
    expect(hashSourceMessage({ ...message, text: 'changed' })).not.toBe(
      hashSourceMessage(message),
    );
  });
  it('keeps positions above the JavaScript integer limit exact', () => {
    expect(SourceMessageSchema.parse(message).sourcePosition).toBe(
      '9007199254740993',
    );
    expect(
      SourceMessageSchema.safeParse({
        ...message,
        sourcePosition: 9007199254740993,
      }).success,
    ).toBe(false);
  });
  it('rejects bookmark fields and unknown append controls', () => {
    expect(
      AppendSourceMessageRequestSchema.safeParse({
        binding: {
          discussionId: 'D1',
          generation: 1,
          workspaceId: 'W1',
          tenderId: 'T1',
        },
        authority: {
          authorityId: 'A',
          authorityVersion: '1',
          kind: 'service',
          subject: 'app',
          expiresAt: '2026-12-01T00:00:00.000Z',
        },
        message,
        idempotencyKey: 'delivery1',
        lastReadPosition: '7',
      }).success,
    ).toBe(false);
  });
});
