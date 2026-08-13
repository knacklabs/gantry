import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';

import {
  evaluateNeutralToolPreChecks,
  type NeutralToolGateContext,
} from '../../../../runner/tool-gate-core.js';
import {
  requestPermissionApprovalViaIpc,
  type PermissionIpcRuntimeEnv,
} from '../../../../runner/permission-ipc-client.js';
import { isGrantableAutonomousToolRecovery } from '../../../../shared/autonomous-tool-denial.js';
import { autonomousToolRecoveryAction } from '../../../../shared/tool-execution-policy-service.js';

// Wraps each selected third-party (configured) MCP tool with the provider-neutral
// runner tool gate before the underlying tool can execute. The decision order
// mirrors the Anthropic lane (tool-permission-gate.ts):
//   1. protected-capability / memory-boundary hard denials,
//   2. tool-execution policy evaluation against the agent's selected rules,
//   3. interactive-required -> requestPermissionApprovalViaIpc, which writes the
//      signed permission-request file the host turns into a durable
//      pending_interactions row BEFORE the prompt renders,
//   4. denial returns the structured tool-error result to the model instead of
//      invoking the underlying tool.
// Tool name/description/schema are preserved so DeepAgents tool events and the
// model-visible tool surface are unchanged; only execution is gated.

export interface ThirdPartyMcpGateConfig {
  workspaceFolder: string;
  memoryBlock: string;
  configuredAllowedTools: readonly string[];
  gateContext: NeutralToolGateContext;
  permissionEnv: PermissionIpcRuntimeEnv;
  capabilityRequestToolsHidden: boolean;
  onPermissionDenied?: (input: DeepAgentsPermissionDenial) => never;
  signal?: AbortSignal;
}

export interface DeepAgentsPermissionDenial {
  toolName: string;
  reason: string;
  grantable: boolean;
  recoveryAction: string;
  denialKind: 'permission_denied' | 'rule_denied';
  provenanceSeam: 'gate' | 'declarative';
  recoveryKind?: 'persistent_capability' | 'job_policy';
}

// Grantability is reconstructed from the tool identity + capabilityRequestToolsHidden
// rather than the raw gate/IPC reason, and that reconstruction is authoritative for
// every denial that reaches here:
//   - The hard, non-grantable policy boundaries (protected-capability, memory,
//     settings-owned yolo denylist) are caught by evaluateNeutralToolPreChecks in
//     the wrapper BEFORE this helper. On a scheduled run those are routed through
//     the terminal onPermissionDenied handler via preCheckDenialResult() with
//     grantable:false (a legible instruction card), so they terminate the run too
//     rather than letting the model silently pick another tool.
//   - Locked-preset / fixed-image agents set capabilityRequestToolsHidden, which
//     makes autonomousGrantRecovery emit a non-request_access instruction →
//     non-grantable — so those boundaries are honored too.
//   - What remains (browser / scoped RunCommand / durable Gantry tool with a
//     request_access recovery) is genuinely grantable: a durable human-approved
//     rule overcomes an autonomous "would-ask" denial on the next run.
export function deepAgentsDenial(
  config: Pick<ThirdPartyMcpGateConfig, 'capabilityRequestToolsHidden'>,
  toolName: string,
  policyRequest: { toolName: string; toolInput: unknown },
  reason: string,
): DeepAgentsPermissionDenial {
  const recoveryAction = autonomousToolRecoveryAction({
    ...policyRequest,
    capabilityRequestToolsHidden: config.capabilityRequestToolsHidden,
  });
  return {
    toolName,
    reason,
    recoveryAction,
    grantable: isGrantableAutonomousToolRecovery(recoveryAction),
    denialKind: 'permission_denied',
    provenanceSeam: 'gate',
  };
}

// Resolve a neutral pre-check failure (protected-capability, memory-boundary,
// settings yolo denylist). These are hard boundaries a durable grant cannot
// overcome, so on a scheduled run (onPermissionDenied present) they terminate the
// turn as a non-grantable instruction rather than reaching the model as an
// ordinary tool message it could ignore and work around; interactive runs keep
// the ordinary tool-error result.
export function preCheckDenialResult(
  config: Pick<ThirdPartyMcpGateConfig, 'onPermissionDenied'>,
  toolName: string,
  preChecks: { reason: string },
): unknown {
  if (config.onPermissionDenied) {
    return config.onPermissionDenied({
      toolName,
      reason: preChecks.reason,
      grantable: false,
      recoveryAction: preChecks.reason,
      denialKind: 'rule_denied',
      provenanceSeam: 'gate',
    });
  }
  return gatedToolErrorResult(preChecks.reason);
}

export function wrapThirdPartyMcpToolsWithGate(
  tools: StructuredToolInterface[],
  serverName: string,
  config: ThirdPartyMcpGateConfig,
): StructuredToolInterface[] {
  return tools.map((underlying) => wrapOne(underlying, serverName, config));
}

function wrapOne(
  underlying: StructuredToolInterface,
  serverName: string,
  config: ThirdPartyMcpGateConfig,
): StructuredToolInterface {
  const gatedFunc = async (input: unknown): Promise<unknown> => {
    config.signal?.throwIfAborted();
    const toolName = canonicalThirdPartyMcpToolName(
      serverName,
      underlying.name,
    );

    const preChecks = evaluateNeutralToolPreChecks({
      toolName,
      toolInput: input,
      memoryBlock: config.memoryBlock,
      // The model sees the raw MCP name, while the gate uses the canonical
      // mcp__server__tool name. Keep the explicit MCP signal as defense in depth.
      isThirdPartyMcpTool: true,
      yoloMode: config.gateContext.yoloMode,
    });
    if (preChecks) {
      return preCheckDenialResult(config, toolName, preChecks);
    }

    const approval = await requestPermissionApprovalViaIpc(
      config.permissionEnv,
      {
        appId: config.permissionEnv.appId,
        agentId: config.permissionEnv.agentId || undefined,
        agentFolder: config.workspaceFolder,
        targetJid: config.permissionEnv.chatJid || undefined,
        toolName,
        toolInput: input,
        threadId: config.gateContext.threadId,
        ...(config.signal ? { signal: config.signal } : {}),
      },
    );
    if (approval.approved) {
      config.signal?.throwIfAborted();
      return invokeUnderlying(underlying, input);
    }
    const reason = approval.reason || 'Denied by operator';
    if (config.onPermissionDenied) {
      return config.onPermissionDenied(
        deepAgentsDenial(
          config,
          toolName,
          { toolName, toolInput: input },
          reason,
        ),
      );
    }
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
): Promise<unknown> {
  return underlying.invoke(input as never);
}

export function canonicalThirdPartyMcpToolName(
  serverName: string,
  toolName: string,
): string {
  return `mcp__${serverName}__${toolName}`;
}

export function gatedToolErrorResult(
  message: string,
  category: 'business' | 'permission' | 'validation' = 'permission',
): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  error: {
    category: 'business' | 'permission' | 'validation';
    isRetryable: false;
    message: string;
  };
} {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    error: { category, isRetryable: false, message },
  };
}

function denyMessage(reason: string) {
  return gatedToolErrorResult(reason);
}
