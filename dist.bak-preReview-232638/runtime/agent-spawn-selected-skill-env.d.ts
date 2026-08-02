import type { CapabilityRuntimeAccess } from '../shared/capability-runtime-access.js';
import type { RunAgentOptions } from './agent-spawn-types.js';
export declare function resolveSelectedSkillEnvForSpawn(input: {
    options?: RunAgentOptions;
    effectiveRuntimeAccess: CapabilityRuntimeAccess[];
}): Promise<{
    env: Record<string, string>;
}>;
