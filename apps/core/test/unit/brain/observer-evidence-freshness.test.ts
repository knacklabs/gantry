import { describe, expect, it, vi } from 'vitest';

import {
  MessageInsightFreshnessProbe,
  type FreshnessMessageReader,
} from '@core/brain/observer-evidence-freshness.js';
import type { ObserverInsightEvidenceRef } from '@core/domain/ports/observer-insights.js';

const BATCH_AT = '2026-07-24T08:00:00.000Z';

function probeWith(messages: unknown[]): {
  probe: MessageInsightFreshnessProbe;
  reader: FreshnessMessageReader;
  getMessagesSince: ReturnType<typeof vi.fn>;
} {
  const getMessagesSince = vi.fn().mockResolvedValue(messages);
  const reader: FreshnessMessageReader = { getMessagesSince };
  return {
    probe: new MessageInsightFreshnessProbe(reader),
    reader,
    getMessagesSince,
  };
}

function evidence(
  overrides: Partial<ObserverInsightEvidenceRef> = {},
): ObserverInsightEvidenceRef {
  return {
    conversationId: 'conversation:slack:C1',
    messageId: 'm1',
    ts: BATCH_AT,
    providerAccountId: 'slack-one',
    conversationJid: 'slack:C1',
    ...overrides,
  };
}

describe('MessageInsightFreshnessProbe', () => {
  it('fails closed (stale) when evidence lacks provider-account provenance', async () => {
    const { probe, getMessagesSince } = probeWith([]);
    await expect(
      probe.isStale({
        batchSnapshotAt: BATCH_AT,
        evidenceRefs: [
          // legacy row: no providerAccountId / conversationJid
          {
            conversationId: 'conversation:slack:C1',
            messageId: 'm1',
            ts: BATCH_AT,
          },
        ],
      }),
    ).resolves.toBe(true);
    expect(getMessagesSince).not.toHaveBeenCalled();
  });

  it('fails closed (stale) when there is no evidence at all', async () => {
    const { probe } = probeWith([]);
    await expect(
      probe.isStale({ batchSnapshotAt: BATCH_AT, evidenceRefs: [] }),
    ).resolves.toBe(true);
  });

  it('is fresh when no later inbound message exists', async () => {
    const { probe, getMessagesSince } = probeWith([]);
    await expect(
      probe.isStale({ batchSnapshotAt: BATCH_AT, evidenceRefs: [evidence()] }),
    ).resolves.toBe(false);
    expect(getMessagesSince).toHaveBeenCalledWith('slack:C1', BATCH_AT, 1, {
      providerAccountId: 'slack-one',
    });
  });

  it('is stale when a later inbound message exists', async () => {
    const { probe } = probeWith([{ id: 'later' }]);
    await expect(
      probe.isStale({ batchSnapshotAt: BATCH_AT, evidenceRefs: [evidence()] }),
    ).resolves.toBe(true);
  });
});
