import type { Agent } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { ConversationRoute } from '../../../domain/types.js';
import type { ControlAgentSettingsView, ControlRouteContext } from '../handler-context.js';
export declare function loadAgentDelegateSettings(ctx: ControlRouteContext, appId: AppId): Promise<{
    settings: ControlAgentSettingsView;
    revision: number;
}>;
export declare function agentIdentityMap(agents: readonly Agent[]): Map<string, Agent>;
export declare function resolveCallableDelegateRoster(input: {
    appId: AppId;
    orchestrator: Agent;
    folder: string;
    delegates: readonly string[];
    settings: ControlAgentSettingsView;
    conversationRoutes: Record<string, ConversationRoute>;
}): Promise<{
    ref: string;
    agentId: string;
    toolName: string;
    displayName: string;
    persona: "developer" | "generalist" | "sales" | "marketing" | "operations" | "research";
}[]>;
