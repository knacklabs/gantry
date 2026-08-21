import type {
  OutboundDelivery,
  OutboundDeliveryFinalAnswer,
  OutboundDeliveryItem,
} from '../outbound-delivery/outbound-delivery.js';
import type { PermissionRecoveryEnvelope } from '../types.js';

export interface SetupPermissionPromptPreparation {
  appId: string;
  jobId: string;
  setupFingerprint: string;
  interaction: {
    id: string;
    runId?: string | null;
    sourceAgentFolder: string;
    requestId: string;
    payload: Record<string, unknown>;
    callbackRoute?: Record<string, unknown> | null;
    idempotencyKey: string;
    expiresAt: string;
  };
  prompt: {
    id: string;
    interactionId: string;
    envelope: PermissionRecoveryEnvelope;
    fullView?: Record<string, unknown> | null;
    providerAliases: string[];
  };
  delivery: Omit<OutboundDelivery, 'appId' | 'idempotencyKey'>;
  finalAnswer: OutboundDeliveryFinalAnswer;
  // Generation authority is INTERNAL: the repository allocates the next
  // generation under the prompt lock (an active generation replays instead).
  item: Omit<OutboundDeliveryItem, 'generation'>;
}

export interface PreparedSetupPermissionPrompt {
  created: boolean;
  promptId: string;
  interactionId: string;
  generation: number;
  delivery: OutboundDelivery;
}

export interface SetupPermissionPromptRepository {
  prepareSetupPermissionPrompt(
    input: SetupPermissionPromptPreparation,
  ): Promise<PreparedSetupPermissionPrompt>;
}
