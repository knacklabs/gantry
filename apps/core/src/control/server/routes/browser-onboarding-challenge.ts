export function onboardingChallengeText(
  agentName: string,
  challenge: string,
): string {
  const handle =
    agentName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'agent';
  return `@${handle} are you there? · ${challenge}`;
}
