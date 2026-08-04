import type { UserQuestionCancellation } from '../domain/types.js';
import { type InteractionCancellationResult } from './interaction-settlement.js';
import type { PendingDiscordQuestion } from './discord-user-question-delivery.js';
export declare function cancelPendingDiscordQuestion(pendingQuestionMap: Map<string, PendingDiscordQuestion>, botToken: string, cancellation: UserQuestionCancellation): Promise<InteractionCancellationResult>;
