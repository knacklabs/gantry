import type { AgentRepository } from '../../domain/ports/repositories.js';
import type { ConversationRoute } from '../../domain/types.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';
export type InlineConfiguredAgents = Record<string, {
    capabilities?: Array<{
        id: string;
    }>;
    delegates?: string[];
    persona?: string;
} | null | undefined>;
export declare function resolveInlineCallableAgentManifest(laneInput: InlineAgentLoopLaneInput, repository: AgentRepository | undefined, configuredAgents?: InlineConfiguredAgents, conversationRoutes?: Record<string, ConversationRoute>, toolsAvailable?: boolean, warn?: (context: Record<string, unknown>, message: string) => void): Promise<import("../../shared/callable-agent-manifest.js").CallableAgentToolManifestEntry[]>;
