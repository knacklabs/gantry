import { describe, it, expect } from 'vitest';
import { SourceContextReceiptSchema } from '../../../../../packages/contracts/src/sessions/source-channel.js';
import { hash } from '../../../src/adapters/storage/postgres/repositories/source-answer-base.postgres.js';
import { contextReceiptFromSnapshot } from '../../../src/adapters/storage/postgres/repositories/source-context-receipt.postgres.js';
const request = {
  binding: {
    discussionId: 'D',
    generation: 1,
    workspaceId: 'W',
    tenderId: 'T',
  },
  answerGoalId: 'G',
  attemptId: 'A',
  questionSourceId: 'Q',
  sourceCutoff: '3',
  revisionId: 'R',
};
const source = {
  sourceMessageId: 'M',
  sourcePosition: '2',
  contentHash: 'a'.repeat(64),
};
describe('runtime-owned conversation context proof', () => {
  it('uses exact selected immutable source proofs, outside model output', () => {
    const result = contextReceiptFromSnapshot(
      request as never,
      { selectionMode: 'recent', sources: [source] },
      undefined,
    );
    expect(SourceContextReceiptSchema.parse(result).sources).toEqual([source]);
    const { receiptHash, ...body } = result;
    expect(receiptHash).toBe(hash(body));
  });
  it('rejects a source beyond the frozen question cutoff', () => {
    expect(() =>
      contextReceiptFromSnapshot(
        request as never,
        {
          selectionMode: 'recent',
          sources: [{ ...source, sourcePosition: '4' }],
        },
        undefined,
      ),
    ).toThrow();
  });
});
