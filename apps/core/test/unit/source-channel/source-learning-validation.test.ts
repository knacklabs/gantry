import { describe, it, expect, vi } from 'vitest';
import { validateSourceLearningProposal } from '../../../src/memory/source-learning-validation.js';
const scope = {
  appId: 'app',
  agentId: 'agent',
  chatJid: 'app:app:D1',
  personId: 'person',
  workspaceId: 'W1',
  runId: 'run1',
};
const context = {
  answerId: 'answer',
  sessionId: 'session',
  claimToken: 'claim',
  scope,
  subject: { subjectType: 'group' },
  request: { model: 'haiku', questionSourceId: 'M2' },
  deadlineAtMs: Date.now() + 180000,
} as never;
const evidence = [
  {
    sourceMessageId: 'M1',
    authorId: 'person',
    text: 'Please separate technical and financial checks.',
    createdAt: '2026-11-17',
    revisionId: 'R1',
  },
  {
    sourceMessageId: 'M2',
    authorId: 'person',
    text: 'Again, check technical and financial eligibility separately.',
    createdAt: '2026-11-17',
    revisionId: 'R1',
  },
];
const proposal = {
  kind: 'constraint',
  key: 'analysis_process',
  value: 'Check technical and financial eligibility separately',
  source: 'discussion-inferred' as const,
  supportingSourceIds: ['M1', 'M2'],
};
const allow = {
  decision: 'allow',
  reusable: true,
  tenderFact: false,
  sensitiveProfile: false,
  scopeAppropriate: true,
  grounding: 'repeated_correction',
  confidence: 0.99,
  supportingSourceIds: ['M1', 'M2'],
  reason: 'Repeated human process instruction',
};
describe('separate source learning validation', () => {
  it('uses a separate bounded Haiku query with exact human evidence and no tools', async () => {
    const query = vi.fn(async () => JSON.stringify(allow));
    const result = await validateSourceLearningProposal({
      candidateId: 'candidate',
      context,
      evidence,
      proposal,
      client: { isConfigured: () => true, query },
    });
    expect(result.allowed).toBe(true);
    const opts = query.mock.calls[0][0];
    expect(opts.model).toMatch(/^claude-haiku-4-5/);
    expect(opts.toolPolicy).toBe('none');
    expect(opts.maxOutputTokens).toBe(1024);
    expect(opts.prompt).toContain(evidence[1].text);
    expect(opts).not.toHaveProperty('effort');
  });
  for (const value of [
    'For project ALPHA the annual turnover minimum is ₹5000000',
    'Project ALPHA requires ISO 27001 certification',
  ])
    it(`does not activate tender facts: ${value}`, async () => {
      const query = vi.fn(async () =>
        JSON.stringify({
          ...allow,
          decision: 'reject',
          reusable: false,
          tenderFact: true,
          reason: 'Tender-specific requirement',
        }),
      );
      const result = await validateSourceLearningProposal({
        candidateId: 'candidate',
        context,
        evidence,
        proposal: { ...proposal, value },
        client: { isConfigured: () => true, query },
      });
      expect(result.allowed).toBe(false);
      expect(query.mock.calls[0][0].prompt).toContain(value);
    });
  it('fails closed on uncertain or malformed classifier output', async () => {
    for (const response of [
      JSON.stringify({ ...allow, decision: 'uncertain' }),
      'not JSON',
      JSON.stringify({ ...allow, confidence: 0.5 }),
    ])
      expect(
        (
          await validateSourceLearningProposal({
            candidateId: 'c',
            context,
            evidence,
            proposal,
            client: { isConfigured: () => true, query: async () => response },
          })
        ).allowed,
      ).toBe(false);
  });
  it('rejects unsupported grounding before a model call', async () => {
    const query = vi.fn();
    await expect(
      validateSourceLearningProposal({
        candidateId: 'c',
        context,
        evidence: evidence.slice(1),
        proposal,
        client: { isConfigured: () => true, query },
      }),
    ).rejects.toThrow(/repeated/);
    expect(query).not.toHaveBeenCalled();
  });
});
