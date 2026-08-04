import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type SemanticCapabilityDefinition } from '../../../shared/semantic-capabilities.js';
type ToolResponse = {
    content: {
        type: 'text';
        text: string;
    }[];
    isError?: boolean;
};
export type CapabilityReviewSubmitter = (toolName: 'request_permission', requestLabel: string, payload: Record<string, unknown>) => Promise<ToolResponse>;
export type SemanticCapabilityProvider = () => readonly SemanticCapabilityDefinition[] | Promise<readonly SemanticCapabilityDefinition[]>;
type RunCommandFallbackValidator = (input: {
    argvPattern: string;
}) => ToolResponse | null;
export declare function registerAccessRequestTool(server: McpServer, submitCapabilityReviewTask: CapabilityReviewSubmitter, options?: {
    listCapabilities?: SemanticCapabilityProvider;
    isCapabilitySelected?: (capabilityId: string) => boolean;
    isToolSelected?: (toolName: string) => boolean;
    validateRunCommandFallback?: RunCommandFallbackValidator;
}): void;
export {};
