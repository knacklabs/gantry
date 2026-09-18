export const SKILL_APPROVAL_WAIT_MS = 5 * 60 * 1000;
export const SAME_SESSION_SKILL_CONTEXT_MAX_BYTES = 256 * 1024;
export const MCP_PROXY_WAIT_MS = 60 * 1000;
export const EXTERNAL_CAPABILITY_CALL_WAIT_MS_ENV =
  'GANTRY_EXTERNAL_CAPABILITY_CALL_WAIT_MS';
export const MANAGED_CAPABILITY_TOOL_TIMEOUT_MARGIN_MS = 20_000;
export const EXTERNAL_CAPABILITY_CALL_WAIT_GRACE_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_EXTERNAL_CAPABILITY_CALL_WAIT_MS =
  MANAGED_CAPABILITY_TOOL_TIMEOUT_MARGIN_MS -
  EXTERNAL_CAPABILITY_CALL_WAIT_GRACE_MS;

export function resolveExternalCapabilityCallWaitMs(
  raw: string | undefined,
): number {
  if (!raw?.trim()) return MCP_PROXY_WAIT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) &&
    parsed >= MIN_EXTERNAL_CAPABILITY_CALL_WAIT_MS &&
    parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : MCP_PROXY_WAIT_MS;
}
