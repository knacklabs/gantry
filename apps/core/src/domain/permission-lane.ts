export const PermissionLane = {
  InteractiveAuto: 'interactive_auto',
  AutoStrict: 'auto_strict',
  Ask: 'ask',
  Autonomous: 'autonomous',
} as const;

export type PermissionLane =
  (typeof PermissionLane)[keyof typeof PermissionLane];

export const RailSignal = {
  Destructive: 'destructive',
  Egress: 'egress',
  Privileged: 'privileged',
  SecretPath: 'secret_path',
  OutOfTrustedRoot: 'out_of_trusted_root',
  UnsupportedMetaExecutor: 'unsupported_meta_executor',
} as const;

export type RailSignal = (typeof RailSignal)[keyof typeof RailSignal];

export interface RailProvenance {
  signal: RailSignal;
  reason: string;
}
