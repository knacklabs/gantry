/**
 * Process-level drain flag. Set once when the runtime begins graceful shutdown
 * so operational endpoints can report it: `/readyz` returns 503 (the ALB pulls
 * the instance out of rotation) and `/metrics` exports `gantry_draining 1`.
 *
 * This is intentionally a module singleton — one runtime process drains once —
 * mirroring the other bootstrap lifecycle singletons (scheduler loop, live-turn
 * authority). Readers import `isDraining` directly to avoid threading the flag
 * through the control route context.
 */
let draining = false;

export function markDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/** @internal test hook */
export function _resetDrainingStateForTest(): void {
  draining = false;
}
