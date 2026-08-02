import type { MessageActionAffordance, PermissionApprovalRequest, PermissionCallbackScope, UserQuestionRequest } from '../domain/types.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import type { DurableQuestionCallback } from '../application/interactions/pending-interaction-durability.js';
export { agentTodoLines } from './agent-todo-render.js';
export declare const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";
export interface TeamsAdaptiveCardAction {
    type: 'Action.Execute';
    title: string;
    verb: string;
    data: {
        action: 'permission_decision';
        callback: {
            providerAlias: string;
            scope: PermissionCallbackScope;
            matchKind: 'individual' | 'batch';
        };
        decision: string;
    } | {
        action: 'message_action';
        kind: 'live_turn_stop';
        actionToken: string;
        targetJid: string;
        threadId?: string;
    } | {
        action: 'message_action';
        kind: 'scheduler_run_now';
        jobId: string;
        targetJid: string;
        threadId?: string;
    };
}
export interface TeamsAdaptiveCardSubmitAction {
    type: 'Action.Submit';
    title: string;
    data: {
        action: 'gantry_userq';
        callback: DurableQuestionCallback;
        targetJid?: string;
        threadId?: string;
    };
}
export interface TeamsAdaptiveCardPayload {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json';
    type: 'AdaptiveCard';
    version: '1.5';
    body: Array<Record<string, unknown>>;
    actions: Array<TeamsAdaptiveCardAction | TeamsAdaptiveCardSubmitAction>;
}
export interface TeamsAdaptiveCardDescriptorPayload {
    attachments: [
        {
            contentType: typeof TEAMS_ADAPTIVE_CARD_CONTENT_TYPE;
            content: TeamsAdaptiveCardPayload;
        }
    ];
}
export declare function formatTeamsAttachmentUnavailableCopy(text: string, filesPresent?: boolean): string;
export declare function buildTeamsApprovalAdaptiveCard(request: PermissionApprovalRequest, callback?: {
    providerAlias: `${string}-${string}-${string}-${string}-${string}`;
    scope: {
        appId: string;
        sourceAgentFolder: string;
        interactionId: string;
    };
    matchKind: "individual" | "batch";
}): TeamsAdaptiveCardPayload;
export declare function buildTeamsApprovalDescriptorPayload(request: PermissionApprovalRequest): TeamsAdaptiveCardDescriptorPayload;
export declare function buildTeamsAgentTodoCard(render: AgentTodoRender, targetJid?: string): TeamsAdaptiveCardPayload;
export declare function buildTeamsMessageCard(options: {
    text: string;
    targetJid: string;
    threadId?: string;
    actionOnly?: boolean;
    actionAffordances?: MessageActionAffordance[];
}): TeamsAdaptiveCardPayload;
export declare function buildTeamsUserQuestionCard(request: UserQuestionRequest, callback: DurableQuestionCallback, startIndex?: number): TeamsAdaptiveCardPayload;
export declare function buildTeamsUserQuestionReceiptCard(text: string): TeamsAdaptiveCardPayload;
