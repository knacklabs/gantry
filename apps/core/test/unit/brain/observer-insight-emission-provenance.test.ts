import { describe, expect, it } from 'vitest';

import {
  normalizePageCandidate,
  observerSubjectForPage,
  parseChannelSourceRef,
} from '@core/brain/observer-insight-emission.js';
import type { BrainPage } from '@core/brain/brain-types.js';
import type { SurfaceableInsightDraft } from '@core/brain/observer-insight-emission.js';

function channelPage(sourceRef: string | null): BrainPage {
  return {
    id: 'page-1',
    appId: 'default',
    slug: 'chan-page',
    title: 'Channel page',
    markdown: 'The team will ship on Friday.',
    sourceKind: 'channel',
    sourceRef,
    authorId: null,
    metadata: {},
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

const draft: SurfaceableInsightDraft = {
  insightType: 'commitment',
  title: 'Ship date',
  summary: 'The team committed to Friday.',
  canonicalSignature: 'ship on friday',
  confidence: 0.9,
  evidencePageIds: ['msg-1'],
};

describe('observer emission evidence provenance', () => {
  it('parses the account-qualified channel source ref (jid may contain colons)', () => {
    expect(parseChannelSourceRef('slack-one:slack:C123#2026-07-24')).toEqual({
      providerAccountId: 'slack-one',
      conversationJid: 'slack:C123',
      discriminator: '2026-07-24',
    });
    expect(parseChannelSourceRef(null)).toBeNull();
    expect(parseChannelSourceRef('no-colon')).toBeNull();
  });

  it('keeps the subject account-agnostic but stores account-qualified evidence', () => {
    const page = channelPage('slack-one:slack:C123#2026-07-24');
    expect(observerSubjectForPage(page)).toBe('conversation:slack:C123');

    const candidate = normalizePageCandidate({ draft, page });
    expect(candidate?.evidenceRefs).toEqual([
      {
        conversationId: 'conversation:slack:C123',
        messageId: 'msg-1',
        ts: page.updatedAt,
        providerAccountId: 'slack-one',
        conversationJid: 'slack:C123',
      },
    ]);
  });

  it('omits provenance for legacy pages without a parseable source ref', () => {
    const candidate = normalizePageCandidate({
      draft,
      page: channelPage(null),
    });
    expect(candidate?.evidenceRefs[0]).toEqual({
      conversationId: 'observer:app',
      messageId: 'msg-1',
      ts: '2026-07-24T00:00:00.000Z',
    });
    expect(candidate?.evidenceRefs[0]?.providerAccountId).toBeUndefined();
  });
});
