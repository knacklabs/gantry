import type { GroupProcessingDeps } from './group-processing-types.js';
import {
  resolveTurnPromptCapabilityCatalog,
  resolveTurnSemanticCapabilities,
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillContext,
  resolveTurnToolPolicy,
} from './group-run-context.js';
import { resolveSpawnPromptAccessPreset } from './agent-spawn-prompt.js';
import { buildProviderSessionAccessFingerprint } from './provider-session-access-fingerprint.js';

export async function resolveGroupAgentAccessContext(input: {
  deps: GroupProcessingDeps;
  turnContext?: { appId: string; agentId: string } | null;
  catalogScope: { appId: string; agentId: string };
  agentFolder: string;
}) {
  // Preserve the original resolution order exactly: the initial three resolve
  // together, then MCP server ids after (this extraction must be
  // behavior-preserving, not a parallelization change).
  const [configuredToolPolicy, selectedSkillContext, semanticCapabilities] =
    await Promise.all([
      resolveTurnToolPolicy(input.deps, input.turnContext),
      resolveTurnSelectedSkillContext(input.deps, input.turnContext),
      resolveTurnSemanticCapabilities(input.deps, input.turnContext),
    ]);
  const attachedMcpSourceIds = await resolveTurnSelectedMcpServerIds(
    input.deps,
    input.turnContext,
  );
  const capabilityCatalog = await resolveTurnPromptCapabilityCatalog(
    input.deps,
    input.catalogScope,
    configuredToolPolicy.semanticCapabilities,
  );
  const lockStatus = input.deps.getAgentLockStatus?.(input.agentFolder);
  const accessPreset = resolveSpawnPromptAccessPreset(
    lockStatus === 'locked' || lockStatus === 'unknown' ? 'locked' : 'full',
    process.env.GANTRY_NO_PERMISSION_TOOLS === '1',
  );
  const currentAccessFingerprint = buildProviderSessionAccessFingerprint({
    accessPreset,
    toolPolicyRules: configuredToolPolicy.toolPolicyRules,
    runtimeAccess: configuredToolPolicy.runtimeAccess,
    attachedSkillSourceIds: selectedSkillContext.ids,
    attachedMcpSourceIds,
    semanticCapabilities,
    capabilityCatalogDigest: capabilityCatalog.digest,
  });
  return {
    configuredToolPolicy,
    selectedSkillContext,
    semanticCapabilities,
    attachedMcpSourceIds,
    capabilityCatalog,
    currentAccessFingerprint,
  };
}
