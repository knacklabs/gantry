import type { McpServerDefinition } from '../../domain/mcp/mcp-servers.js';
import { stableSha256Json } from '../../shared/stable-hash.js';

export function mcpServerDefinitionFingerprint(
  server: McpServerDefinition,
): string {
  return stableSha256Json({
    id: server.id,
    appId: server.appId,
    name: server.name,
    transport: server.transport,
    config: server.config,
    allowedToolPatterns: canonicalStringSet(server.allowedToolPatterns),
    autoApproveToolPatterns: canonicalStringSet(server.autoApproveToolPatterns),
    credentialRefs: canonicalCredentialRefs(server.credentialRefs),
    networkHosts: canonicalStringSet(server.networkHosts),
    sandboxProfileId: server.sandboxProfileId,
    riskClass: server.riskClass,
  });
}

function canonicalStringSet(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()))].sort();
}

function canonicalCredentialRefs(
  values: McpServerDefinition['credentialRefs'] | undefined,
): McpServerDefinition['credentialRefs'] {
  const byIdentity = new Map(
    (values ?? []).map((ref) => [
      `${ref.target}\u0000${ref.key}\u0000${ref.name}`,
      ref,
    ]),
  );
  return [...byIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, ref]) => ref);
}
