import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildExternalPlatformDelivery,
  buildExternalPlatformMessage,
  resolveExternalDeliveryRetryDelayMs,
  signGantryDeliveryStatusRequest,
  signExternalEventRequest,
  verifyExternalEventSignature,
} from '@core/control/server/routes/external-platform-events.js';

const envelope = {
  integrationId: 'integration-test',
  eventId: 'outbox-1',
  eventType: 'notification.card.requested',
  occurredAt: '2026-05-18T10:00:00.000Z',
  target: {
    teamsChannelId: '19:channel@thread.v2',
  },
  payload: {
    eventType: 'notification.card.requested',
    subjectId: 'subject-1',
    title: 'MRI scanner maintenance notice',
    sourceUrl: 'https://example.test/resource',
    documentAttachment: {
      downloadStatus: 'missing',
    },
    requestedAt: '2026-05-18T10:00:00.000Z',
  },
};

const cardEnvelope = {
  ...envelope,
  eventId: 'outbox-card-1',
  payload: {
    ...envelope.payload,
    notificationCard: {
      schemaVersion: 'external.notification.card.v1',
      renderer: 'gantry_adaptive_card',
      teamsCompatibility: {
        adaptiveCardVersion: '1.2',
        requiresBotForSubmitActions: true,
      },
      subjectId: 'subject-1',
      scopeId: 'scope-1',
      sourceConversationId: '19:channel@thread.v2',
      teamsTenantId: 'tenant-1',
      title: 'MRI scanner maintenance notice',
      summary: 'Maintenance notice for matched biomedical scope.',
      facts: [
        { label: 'Resource ID', value: 'subject-1' },
        { label: 'Amount', value: 'INR 50,000' },
        { label: 'Scope', value: 'Biomedical' },
        { label: 'Organization', value: 'External Hospital' },
        { label: 'Location', value: 'Bengaluru' },
        { label: 'Due date', value: '2026-05-31' },
        { label: 'Published', value: '2026-05-18' },
      ],
      links: [
        { label: 'notice.pdf', url: 'https://example.test/documents/notice.pdf' },
      ],
      actions: [
        {
          actionType: 'track_subject',
          label: 'Watch',
          presentation: 'submit',
          platformOperation: 'mark_resource',
          requiresActionCapableTeamsSurface: true,
        },
        {
          actionType: 'request_review',
          label: 'Request analysis',
          presentation: 'submit',
          platformOperation: 'request_review',
          requiresActionCapableTeamsSurface: true,
        },
      ],
      fallbackText: 'Notification: MRI scanner maintenance notice',
    },
  },
};

const messageNotificationEnvelope = {
  integrationId: 'integration-test',
  eventId: 'message-outbox-1',
  eventType: 'notification.message.requested',
  occurredAt: '2026-05-18T10:00:00.000Z',
  target: {
    teamsChannelId: '19:channel@thread.v2',
  },
  payload: {
    eventType: 'notification.message.requested',
    message: 'Platform User, the requested review for subject-1 is completed.',
    threadId: 'reply-1',
    occurredAt: '2026-05-18T10:05:00.000Z',
  },
};

describe('External platform event adapter helpers', () => {
  beforeEach(() => {
    process.env.GANTRY_EXTERNAL_ACTION_SECRET = 'action-secret';
    process.env.GANTRY_EXTERNAL_TEAMS_TENANT_ID = 'tenant-1';
  });
  it('signs and verifies External event requests', () => {
    const rawBody = JSON.stringify(envelope);
    const signature = signExternalEventRequest({
      secret: 'secret',
      method: 'POST',
      path: '/v1/integrations/platform-events',
      timestamp: '1000',
      nonce: 'nonce-1',
      rawBody,
    });

    expect(
      verifyExternalEventSignature({
        secret: 'secret',
        method: 'POST',
        path: '/v1/integrations/platform-events',
        timestamp: '1000',
        nonce: 'nonce-1',
        rawBody,
        signature,
        nowMs: 1000,
      }),
    ).toBe(true);
    expect(
      verifyExternalEventSignature({
        secret: 'wrong',
        method: 'POST',
        path: '/v1/integrations/platform-events',
        timestamp: '1000',
        nonce: 'nonce-1',
        rawBody,
        signature,
        nowMs: 1000,
      }),
    ).toBe(false);
  });

  it('rejects stale timestamps', () => {
    const rawBody = JSON.stringify(envelope);
    const signature = signExternalEventRequest({
      secret: 'secret',
      method: 'POST',
      path: '/v1/integrations/platform-events',
      timestamp: '1000',
      nonce: 'nonce-1',
      rawBody,
    });

    expect(
      verifyExternalEventSignature({
        secret: 'secret',
        method: 'POST',
        path: '/v1/integrations/platform-events',
        timestamp: '1000',
        nonce: 'nonce-1',
        rawBody,
        signature,
        nowMs: 10 * 60_000,
      }),
    ).toBe(false);
  });

  it('builds deterministic Teams text for card notification events', () => {
    expect(buildExternalPlatformMessage(cardEnvelope)).toContain(
      'Notification: MRI scanner maintenance notice',
    );
    expect(buildExternalPlatformMessage(cardEnvelope)).toContain(
      'Organization: External Hospital',
    );
    expect(buildExternalPlatformMessage(cardEnvelope)).not.toContain('Reference');
  });

  it('builds thread-targeted Teams text for generic message notifications', () => {
    const text = buildExternalPlatformMessage(messageNotificationEnvelope);
    expect(text).toContain(
      'Platform User, the requested review for subject-1 is completed.',
    );

    const delivery = buildExternalPlatformDelivery(messageNotificationEnvelope);
    expect(delivery.kind).toBe('text');
    expect(delivery.threadId).toBe('reply-1');
  });

  it('builds an Adaptive Card delivery when notification card data is present', () => {
    const delivery = buildExternalPlatformDelivery(cardEnvelope);
    expect(delivery.kind).toBe('adaptive_card');
    if (delivery.kind !== 'adaptive_card') return;
    expect(delivery.card.version).toBe('1.2');
    expect(delivery.card.body[0]).toMatchObject({
      type: 'TextBlock',
      text: 'MRI scanner maintenance notice',
    });
    expect(JSON.stringify(delivery.card.body)).toContain('Resource ID');
    expect(JSON.stringify(delivery.card.body)).toContain('subject-1');
    expect(JSON.stringify(delivery.card.body)).toContain('Amount');
    expect(JSON.stringify(delivery.card.body)).toContain('INR 50,000');
    expect(JSON.stringify(delivery.card.body)).toContain('Scope');
    expect(JSON.stringify(delivery.card.body)).toContain('Organization');
    expect(JSON.stringify(delivery.card.body)).toContain('Location');
    expect(JSON.stringify(delivery.card.body)).toContain('Due date');
    expect(JSON.stringify(delivery.card.body)).toContain('Published');
    expect(JSON.stringify(delivery.card.body)).not.toContain('Reference');
    expect(JSON.stringify(delivery.card.body)).not.toContain(
      'Matched keywords',
    );
    expect(JSON.stringify(delivery.card.body)).toContain('Links');
    expect(JSON.stringify(delivery.card.body)).toContain(
      '[notice.pdf](https://example.test/documents/notice.pdf)',
    );
    expect(delivery.card.actions).toEqual([
      {
        type: 'Action.Submit',
        title: 'Watch',
        data: expect.objectContaining({
          action: 'external_card_action',
          actionType: 'track_subject',
          platformOperation: 'mark_resource',
          integrationId: 'integration-test',
          subjectId: 'subject-1',
          scopeId: 'scope-1',
          sourceConversationId: '19:channel@thread.v2',
          teamsTenantId: 'tenant-1',
          nonce: expect.any(String),
          expiresAt: expect.any(String),
          signature: expect.any(String),
        }),
      },
      {
        type: 'Action.Submit',
        title: 'Request analysis',
        data: expect.objectContaining({
          actionType: 'request_review',
          platformOperation: 'request_review',
        }),
      },
    ]);
  });

  it('renders document links in body text with escaping and URL validation', () => {
    const delivery = buildExternalPlatformDelivery({
      ...cardEnvelope,
      payload: {
        ...cardEnvelope.payload,
        notificationCard: {
          ...cardEnvelope.payload.notificationCard,
          links: [
            {
              label: 'Spec [final] (v2).pdf',
              url: 'https://example.test/documents/spec(1).pdf',
            },
            {
              label: 'bad.pdf',
              url: 'ftp://example.test/bad.pdf',
            },
            {
              label: 'boq.pdf',
              url: 'https://example.test/documents/boq.pdf',
            },
          ],
        },
      },
    });
    expect(delivery.kind).toBe('adaptive_card');
    if (delivery.kind !== 'adaptive_card') return;

    const body = JSON.stringify(delivery.card.body);
    expect(body).toContain(
      '[Spec \\\\[final\\\\] \\\\(v2\\\\).pdf](https://example.test/documents/spec%281%29.pdf)',
    );
    expect(body).toContain('[boq.pdf](https://example.test/documents/boq.pdf)');
    expect(body).not.toContain('ftp://example.test/bad.pdf');
    expect(body).not.toContain('missing.pdf');
    expect(JSON.stringify(delivery.card.actions)).not.toContain(
      'Action.OpenUrl',
    );
  });

  it('omits submit actions when no Teams tenant id is available for signing', () => {
    delete process.env.GANTRY_EXTERNAL_TEAMS_TENANT_ID;
    delete process.env.TEAMS_TENANT_ID;

    const delivery = buildExternalPlatformDelivery({
      ...cardEnvelope,
      payload: {
        ...cardEnvelope.payload,
        notificationCard: {
          ...cardEnvelope.payload.notificationCard,
          teamsTenantId: null,
        },
      },
    });
    expect(delivery.kind).toBe('adaptive_card');
    if (delivery.kind !== 'adaptive_card') return;
    expect(JSON.stringify(delivery.card.body)).toContain(
      '[notice.pdf](https://example.test/documents/notice.pdf)',
    );
    expect(delivery.card.actions).toEqual([]);
  });

  it('signs External delivery status callbacks with the platform callback path', () => {
    const rawBody = JSON.stringify({
      eventId: 'outbox-1',
      status: 'delivered',
      deliveredAt: '2026-05-18T10:00:01.000Z',
      teamsMessageId: 'teams-message-1',
    });

    expect(
      signGantryDeliveryStatusRequest({
        secret: 'secret',
        method: 'POST',
        path: '/hooks/gantry/delivery-status',
        timestamp: '1000',
        nonce: 'nonce-1',
        rawBody,
      }),
    ).toBe(
      signExternalEventRequest({
        secret: 'secret',
        method: 'POST',
        path: '/hooks/gantry/delivery-status',
        timestamp: '1000',
        nonce: 'nonce-1',
        rawBody,
      }),
    );
  });

  it('backs off External delivery retries with a cap', () => {
    expect(resolveExternalDeliveryRetryDelayMs(0)).toBe(5000);
    expect(resolveExternalDeliveryRetryDelayMs(1)).toBe(10000);
    expect(resolveExternalDeliveryRetryDelayMs(20)).toBe(60000);
  });
});
