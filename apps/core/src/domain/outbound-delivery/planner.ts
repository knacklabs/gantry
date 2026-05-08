import type { AppId } from '../app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../conversation/conversation.js';

export interface OutboundDeliveryPlanPart {
  canonicalText: string;
  providerPayload?: unknown;
}

export interface OutboundDeliveryPlan {
  parts: OutboundDeliveryPlanPart[];
  canonicalFinalText?: string;
}

export interface OutboundDeliveryPlanInput {
  appId: AppId;
  conversationId: ConversationId;
  threadId?: ConversationThreadId;
  profileId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundDeliveryProfile {
  readonly profileId: string;
  plan(
    input: OutboundDeliveryPlanInput,
  ): Promise<OutboundDeliveryPlan> | OutboundDeliveryPlan;
}

export interface OutboundDeliveryProfileRegistry {
  resolve(profileId: string): OutboundDeliveryProfile | undefined;
}
