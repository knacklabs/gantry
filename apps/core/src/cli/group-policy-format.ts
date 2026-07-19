import type { RuntimeSettings } from '../config/settings/runtime-settings.js';

function renderAllow(allow: '*' | string[]): string {
  if (allow === '*') return '*';
  return allow.length > 0 ? allow.join(',') : '(none)';
}

export function printPolicyChannel(
  providerId: string,
  settings: RuntimeSettings,
): void {
  const provider = settings.providers[providerId];
  const entries = Object.values(settings.conversations)
    .flatMap((conversation) => {
      const connection =
        settings.providerAccounts[conversation.providerAccount];
      if (connection?.provider !== providerId) return [];
      return Object.values(conversation.installedAgents ?? {})
        .filter((install) => install.status === 'active')
        .map(
          (install) => [install.agentId, conversation.senderPolicy] as const,
        );
    })
    .sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    `${providerId}:`,
    `  enabled: ${provider?.enabled ? 'yes' : 'no'}`,
    '  agents:',
  ];
  if (entries.length === 0) {
    lines.push('    (none)');
  } else {
    for (const [folder, entry] of entries) {
      lines.push(
        `    ${folder}: allow=${renderAllow(entry.allow)} mode=${entry.mode}`,
      );
    }
  }
  console.log(lines.join('\n'));
}
