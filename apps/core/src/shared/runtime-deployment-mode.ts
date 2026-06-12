// Deployment topology (one machine vs many). Distinct axis from security
// posture (GANTRY_SECURITY_POSTURE env). `workstation` is today's single-node
// behavior with live installs; `fleet` runs immutable workers that fetch
// capability artifacts produced by bake jobs.
//
// Lives in the provider-neutral shared layer so runtime-layer fleet/capability
// dispatch can consume the type without importing the config layer; config
// re-exports it as part of RuntimeProcessSettings.
export type RuntimeDeploymentMode = 'workstation' | 'fleet';
