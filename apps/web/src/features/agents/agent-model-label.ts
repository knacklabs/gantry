export function agentModelLabel(
  displayName: string | null | undefined,
  providerId: string | null | undefined,
  providerLabel: string | null | undefined,
): string {
  if (!displayName) return 'Deployment default';
  if (providerId === 'anthropic' && !displayName.startsWith('Claude '))
    return `Claude ${displayName}`;
  const prefix = providerId === 'bedrock' ? 'Bedrock' : providerLabel;
  if (prefix && displayName.startsWith(`${prefix} `))
    return displayName.slice(prefix.length + 1);
  return displayName;
}
