export function credentialRefsForRequestedMcp(
  serverName: string,
  transport: string,
  credentialNeeds: string[],
) {
  if (transport === 'http' || transport === 'sse') {
    return credentialNeeds.map((ref, index) => ({
      name: secretNameForRequestedMcp(serverName, ref),
      target: 'header' as const,
      key:
        credentialNeeds.length === 1 && index === 0
          ? 'Authorization'
          : headerNameForCredentialNeed(ref),
    }));
  }
  return credentialNeeds.map((ref) => ({
    name: secretNameForRequestedMcp(serverName, ref),
    target: 'env' as const,
    key: secretNameForCredentialNeed(ref),
  }));
}

function secretNameForRequestedMcp(
  serverName: string,
  credentialNeed: string,
): string {
  const server = serverName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const need = secretNameForCredentialNeed(credentialNeed);
  return `MCP_${server || 'SERVER'}_${need}_REF`;
}

function secretNameForCredentialNeed(credentialNeed: string): string {
  const need = credentialNeed
    .replace(/_REF$/i, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  return need.replace(/^_+|_+$/g, '') || 'MCP_CREDENTIAL';
}

export function headerNameForCredentialNeed(credentialNeed: string): string {
  return credentialNeed
    .replace(/_REF$/i, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
