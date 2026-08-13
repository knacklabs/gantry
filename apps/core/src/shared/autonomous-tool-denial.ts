export function isGrantableAutonomousToolRecovery(
  recoveryAction: string | null | undefined,
): boolean {
  if (!recoveryAction?.trim()) return true;
  return recoveryAction.startsWith('request_access ');
}
