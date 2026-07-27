import type { GroupProcessingDeps } from './group-processing-types.js';
import {
  loadAgentAccessSnapshot,
  resolveTurnPromptCapabilityCatalogFromSnapshot,
  resolveTurnSemanticCapabilitiesFromSnapshot,
  resolveTurnSelectedMcpServerIdsFromSnapshot,
  resolveTurnSelectedSkillContextFromSnapshot,
  resolveTurnToolPolicyFromSnapshot,
} from './group-run-context.js';
import { resolveSpawnPromptAccessPreset } from './agent-spawn-prompt.js';
import { buildProviderSessionAccessFingerprint } from './provider-session-access-fingerprint.js';
import { buildApprovedSkillContextBlockFromSkills } from './session-resume-runtime.js';

export async function resolveGroupAgentAccessContext(input: {
  deps: GroupProcessingDeps;
  turnContext?: { appId: string; agentId: string } | null;
  catalogScope: { appId: string; agentId: string };
  agentFolder: string;
}) {
  const accessSnapshot = await loadAgentAccessSnapshot(
    input.deps,
    input.turnContext,
  );
  const configuredToolPolicy =
    resolveTurnToolPolicyFromSnapshot(accessSnapshot);
  const selectedSkillContext =
    resolveTurnSelectedSkillContextFromSnapshot(accessSnapshot);
  const semanticCapabilities =
    resolveTurnSemanticCapabilitiesFromSnapshot(accessSnapshot);
  const attachedMcpSourceIds =
    resolveTurnSelectedMcpServerIdsFromSnapshot(accessSnapshot);
  const capabilityCatalog = accessSnapshot
    ? await resolveTurnPromptCapabilityCatalogFromSnapshot(
        accessSnapshot,
        configuredToolPolicy.semanticCapabilities,
      )
    : await resolveTurnPromptCapabilityCatalogFromSnapshot(
        {
          appId: input.catalogScope.appId,
          agentId: input.catalogScope.agentId,
          tools: { activeBindings: [], appActiveDefinitions: [] },
          skills: { activeBindings: [], enabledDefinitions: [] },
          mcp: { activeBindings: [], materializedServers: [] },
        },
        configuredToolPolicy.semanticCapabilities,
      );
  const approvedSkillContextBlock = accessSnapshot
    ? buildApprovedSkillContextBlockFromSkills(
        accessSnapshot.skills.enabledDefinitions,
      )
    : '';
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
    approvedSkillContextBlock,
    accessSnapshot,
    currentAccessFingerprint,
  };
}
