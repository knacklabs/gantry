import { describe, expect, it } from 'vitest';
import {
  sourceChannelMemorySubject,
  assertSourceLearningContent,
} from '../../../src/memory/source-channel-memory-scope.js';
describe('native workspace memory boundaries', () => {
  const base = {
    appId: 'app',
    agentId: 'agent',
    workspaceId: 'A',
    personId: 'akash',
  };
  it('keeps workspace and personal subjects separate across people and workspaces', () => {
    const a = sourceChannelMemorySubject(base);
    expect(a.subjectType).toBe('group');
    expect(a.subjectId).not.toBe(
      sourceChannelMemorySubject({ ...base, workspaceId: 'B' }).subjectId,
    );
    const akash = sourceChannelMemorySubject({ ...base, scope: 'user' });
    expect(akash.subjectId).not.toBe(
      sourceChannelMemorySubject({ ...base, scope: 'user', personId: 'priya' })
        .subjectId,
    );
    expect(akash.subjectId).not.toBe(
      sourceChannelMemorySubject({ ...base, scope: 'user', workspaceId: 'B' })
        .subjectId,
    );
  });
  it('admits process preferences and rejects tender fact promotion', () => {
    expect(() =>
      assertSourceLearningContent({
        kind: 'preference',
        key: 'analysis_process',
        value: 'Check technical and financial eligibility separately',
      }),
    ).not.toThrow();
    expect(() =>
      assertSourceLearningContent({
        kind: 'fact',
        key: 'closing',
        value: 'Submission closes tomorrow',
      }),
    ).toThrow(/general/);
    expect(() =>
      assertSourceLearningContent({
        kind: 'preference',
        key: 'source',
        value: 'Clause 3 requires 10 years experience',
      }),
    ).toThrow(/Tender facts/);
  });
});
