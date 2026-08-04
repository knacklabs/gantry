import type { StructuredToolInterface } from '@langchain/core/tools';
import { type NeutralToolGateContext } from '../../../../runner/tool-gate-core.js';
import { type PermissionIpcRuntimeEnv } from '../../../../runner/permission-ipc-client.js';
export interface ThirdPartyMcpGateConfig {
    workspaceFolder: string;
    memoryBlock: string;
    configuredAllowedTools: readonly string[];
    gateContext: NeutralToolGateContext;
    permissionEnv: PermissionIpcRuntimeEnv;
    lockedAccessPreset: boolean;
    signal?: AbortSignal;
}
export declare function wrapThirdPartyMcpToolsWithGate(tools: StructuredToolInterface[], serverName: string, config: ThirdPartyMcpGateConfig): StructuredToolInterface[];
export declare function canonicalThirdPartyMcpToolName(serverName: string, toolName: string): string;
export declare function gatedToolErrorResult(message: string, category?: 'business' | 'permission' | 'validation'): {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError: true;
    error: {
        category: 'business' | 'permission' | 'validation';
        isRetryable: false;
        message: string;
    };
};
