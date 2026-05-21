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
    resourceId: 'resource-1',
    title: 'MRI scanner maintenance tender',
    referenceNo: 'MPL-001',
    organization: 'External Hospital',
    deadline: '2026-05-31',
    sourceUrl: 'https://example.test/tender',
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
      title: 'MRI scanner maintenance tender',
      referenceNo: 'MPL-001',
      organization: 'External Hospital',
      deadline: '2026-05-31',
      summary: 'Maintenance tender for matched biomedical workspace.',
      sourceUrl: 'https://example.test/tender',
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Biomedical',
        teamsChannelId: '19:channel@thread.v2',
        matchedKeywords: ['mri'],
      },
      primaryDocument: {
        signedDownloadUrl: null,
      },
      documents: [],
      actions: [
        {
          actionType: 'open_source',
          label: 'Open source',
          presentation: 'open_url',
          url: 'https://example.test/tender',
          platformOperation: null,
        },
        {
          actionType: 'mark_watching',
          label: 'Watch',
          presentation: 'submit',
          platformOperation: 'mark_resource',
          requiresActionCapableTeamsSurface: true,
        },
        {
          actionType: 'request_analysis',
          label: 'Request analysis',
          presentation: 'submit',
          platformOperation: 'request_analysis',
          requiresActionCapableTeamsSurface: true,
        },
      ],
      fallbackText: 'Tender notice: MRI scanner maintenance tender',
    },
  },
};

describe('External platform event adapter helpers', () => {
  beforeEach(() => {
    process.env.GANTRY_EXTERNAL_ACTION_SECRET = 'action-secret';
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
    expect(buildExternalPlatformMessage(envelope)).toContain(
      'Notification: MRI scanner maintenance tender',
    );
    expect(buildExternalPlatformMessage(envelope)).toContain(
      'Organization: External Hospital',
    );
  });

  it('builds an Adaptive Card delivery when notification card data is present', () => {
    const delivery = buildExternalPlatformDelivery(cardEnvelope);
    expect(delivery.kind).toBe('adaptive_card');
    if (delivery.kind !== 'adaptive_card') return;
    expect(delivery.card.version).toBe('1.2');
    expect(delivery.card.body[0]).toMatchObject({
      type: 'TextBlock',
      text: 'MRI scanner maintenance tender',
    });
    expect(delivery.card.actions).toEqual([
      {
        type: 'Action.OpenUrl',
        title: 'Open source',
        url: 'https://example.test/tender',
      },
      {
        type: 'Action.Submit',
        title: 'Watch',
        data: expect.objectContaining({
          action: 'external_card_action',
          actionType: 'mark_watching',
          platformOperation: 'mark_resource',
          integrationId: 'integration-test',
          resourceId: 'resource-1',
          sourceChannelId: '19:channel@thread.v2',
          nonce: expect.any(String),
          expiresAt: expect.any(String),
          signature: expect.any(String),
        }),
      },
      {
        type: 'Action.Submit',
        title: 'Request analysis',
        data: expect.objectContaining({
          actionType: 'request_analysis',
          platformOperation: 'request_analysis',
        }),
      },
    ]);
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
