import { describe, expect, it } from 'vitest';
import {
  sourceChannelMemorySubject,
  sourceChannelNativePersonId,
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
  it('keeps the native person FK app-scoped while retaining workspace-specific preference subjects', () => {
    expect(sourceChannelNativePersonId('app-A', 'same-person')).not.toBe(
      sourceChannelNativePersonId('app-B', 'same-person'),
    );
    expect(sourceChannelMemorySubject({ ...base, scope: 'user' }).userId).toBe(
      sourceChannelNativePersonId(base.appId, base.personId),
    );
  });
  it('limits structural learning kinds before the independent semantic check', () => {
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
    // A kind label cannot establish generality. The independent source-grounded
    // validator decides whether free-form content can activate.
    expect(() =>
      assertSourceLearningContent({
        kind: 'constraint',
        key: 'qualification',
        value: 'Project ALPHA requires ISO 27001 certification',
      }),
    ).not.toThrow();
  });
});
