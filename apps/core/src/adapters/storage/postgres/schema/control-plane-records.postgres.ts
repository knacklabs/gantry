export type ControlResponseMode = 'sse' | 'webhook' | 'both' | 'none';

export interface AppSessionRecord {
  sessionId: string;
  appId: string;
  conversationId: string;
  chatJid: string;
  workspaceFolder: string;
  workspaceKey: string;
  title: string | null;
  defaultResponseMode: ControlResponseMode;
  defaultWebhookId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ControlEventRecord {
  eventId: number;
  appId: string;
  eventType: string;
  sessionId: string | null;
  jobId: string | null;
  runId: string | null;
  triggerId: string | null;
  correlationId: string | null;
  actor: string;
  payload: string;
  createdAt: string;
}

export interface WebhookRegistrationRecord {
  webhookId: string;
  appId: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryRecord {
  deliveryId: string;
  webhookId: string;
  eventId: number;
  status: string;
  attemptCount: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobTriggerRecord {
  triggerId: string;
  jobId: string;
  runId: string | null;
  requestedAt: string;
  requestedBy: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppResponseRouteRecord {
  sessionId: string;
  threadId: string;
  responseMode: ControlResponseMode;
  webhookId: string | null;
  correlationId: string | null;
  updatedAt: string;
}

export interface ClaimedWebhookDeliveryRecord extends WebhookDeliveryRecord {
  webhook:
    | (WebhookRegistrationRecord & {
        secret: string;
      })
    | null;
  event: ControlEventRecord | null;
  eventAppId: string | null;
}
