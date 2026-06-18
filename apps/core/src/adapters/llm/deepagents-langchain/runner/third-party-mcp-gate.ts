import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';

import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../../../shared/tool-execution-policy-service.js';
import {
  evaluateNeutralToolPreChecks,
  evaluateNeutralToolPolicy,
  LOCKED_ACCESS_PRESET_DENY_REASON,
  type NeutralToolGateContext,
} from '../../../../runner/tool-gate-core.js';
import {
  requestPermissionApprovalViaIpc,
  type PermissionIpcRuntimeEnv,
} from '../../../../runner/permission-ipc-client.js';

// Wraps each selected third-party (configured) MCP tool with the provider-neutral
// runner tool gate before the underlying tool can execute. The decision order
// mirrors the Anthropic lane (tool-permission-gate.ts):
//   1. protected-capability / memory-boundary hard denials,
//   2. tool-execution policy evaluation against the agent's selected rules,
//   3. interactive-required -> requestPermissionApprovalViaIpc, which writes the
//      signed permission-request file the host turns into a durable
//      pending_interactions row BEFORE the prompt renders,
//   4. denial returns a tool-error string to the model (imitating the anthropic
//      lane deny copy) instead of invoking the underlying tool.
// Tool name/description/schema are preserved so DeepAgents tool events and the
// model-visible tool surface are unchanged; only execution is gated.

export interface ThirdPartyMcpGateConfig {
  workspaceFolder: string;
  memoryBlock: string;
  configuredAllowedTools: readonly string[];
  gateContext: NeutralToolGateContext;
  permissionEnv: PermissionIpcRuntimeEnv;
  lockedAccessPreset: boolean;
}

export function wrapThirdPartyMcpToolsWithGate(
  tools: StructuredToolInterface[],
  config: ThirdPartyMcpGateConfig,
): StructuredToolInterface[] {
  const classifier = new ToolExecutionClassifier();
  const policy = new ToolExecutionPolicyService();
  return tools.map((underlying) =>
    wrapOne(underlying, config, classifier, policy),
  );
}

function wrapOne(
  underlying: StructuredToolInterface,
  config: ThirdPartyMcpGateConfig,
  classifier: ToolExecutionClassifier,
  policy: ToolExecutionPolicyService,
): StructuredToolInterface {
  const gatedFunc = async (input: unknown): Promise<string> => {
    const toolName = underlying.name;

    const preChecks = evaluateNeutralToolPreChecks({
      toolName,
      toolInput: input,
      memoryBlock: config.memoryBlock,
      // Third-party MCP tools arrive with bare names; flag so the memory-boundary
      // guard scans them as mcp-equivalent (parity with the anthropic lane's
      // mcp__-prefixed names).
      isThirdPartyMcpTool: true,
      yoloMode: config.gateContext.yoloMode,
    });
    if (preChecks) {
      return denyMessage(preChecks.reason);
    }

    const decision = evaluateNeutralToolPolicy({
      classifier,
      policy,
      toolName,
      toolInput: input,
      context: config.gateContext,
      allowedToolRules: config.configuredAllowedTools,
    });
    if (decision.status === 'allow') {
      return invokeUnderlying(underlying, input);
    }

    if (config.lockedAccessPreset) {
      return denyMessage(LOCKED_ACCESS_PRESET_DENY_REASON);
    }

    const approval = await requestPermissionApprovalViaIpc(
      config.permissionEnv,
      {
        appId: config.permissionEnv.appId,
        agentId: config.permissionEnv.agentId || undefined,
        agentFolder: config.workspaceFolder,
        targetJid: config.permissionEnv.chatJid || undefined,
        toolName,
        decisionReason: decision.reason,
        closestRule: decision.closestRule,
        toolInput: input,
        threadId: config.gateContext.threadId,
      },
    );
    if (approval.approved) {
      return invokeUnderlying(underlying, input);
    }
    const reason = approval.reason || 'Denied by operator';
    return denyMessage(`Permission denied: ${reason}`);
  };

  return tool(gatedFunc, {
    name: underlying.name,
    description: underlying.description,
    // @langchain/core tool() accepts the underlying zod/JSON schema directly.
    schema: underlying.schema as never,
  }) as unknown as StructuredToolInterface;
}

async function invokeUnderlying(
  underlying: StructuredToolInterface,
  input: unknown,
): Promise<string> {
  const result = await underlying.invoke(input as never);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function denyMessage(reason: string): string {
  // Returned as the tool result string so the model sees the denial as a tool
  // error and can recover, matching the anthropic lane's deny-to-model copy.
  return reason;
}
