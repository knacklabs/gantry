export interface RuntimeProfileRef {
  id: string;
  version: string;
}

export interface RegisteredRuntimeProfile {
  id: string;
  version: string;
  browserPolicy?: 'public_readonly_research';
  additionalToolRules: readonly string[];
}

const PROFILES: readonly RegisteredRuntimeProfile[] = [
  {
    id: 'public_readonly_research',
    version: '1',
    browserPolicy: 'public_readonly_research',
    additionalToolRules: [
      'mcp__gantry__file',
      'mcp__gantry__job_checkpoint_status',
      'mcp__gantry__job_checkpoint_save',
      'mcp__gantry__external_capability_call',
    ],
  },
];

export function registeredRuntimeProfile(
  ref: RuntimeProfileRef | undefined,
): RegisteredRuntimeProfile | undefined {
  if (!ref) return undefined;
  return PROFILES.find(
    (profile) => profile.id === ref.id && profile.version === ref.version,
  );
}

export function requireRegisteredRuntimeProfile(
  ref: RuntimeProfileRef | undefined,
): RegisteredRuntimeProfile | undefined {
  if (!ref) return undefined;
  const profile = registeredRuntimeProfile(ref);
  if (!profile) {
    throw new Error(
      `Runtime profile is not registered: ${ref.id}@${ref.version}`,
    );
  }
  return profile;
}
