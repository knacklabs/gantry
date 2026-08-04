import type { JobCapabilityRequirement } from '../../domain/types.js';
export declare function normalizeCapabilityRequirements(input: readonly JobCapabilityRequirement[] | undefined): JobCapabilityRequirement[];
export declare function formatCapabilityRequirement(requirement: JobCapabilityRequirement): string;
export declare function capabilityRequirementSetupAction(requirement: JobCapabilityRequirement): string;
export declare function localCliCommandTemplatePermissionRule(commandTemplate: string | undefined, executablePath?: string | undefined): string | undefined;
