import { controlApiRequest } from './control-api.js';

type ProviderModelListing = {
  providerLabel: string;
  discoverySource: 'live' | 'cache' | 'none';
  refreshError: string | null;
  models: Array<{
    providerModelId: string;
    displayName: string;
    aliases: string[];
    availability: string;
  }>;
};

export async function runModelProviderDiscoveryCommand(
  runtimeHome: string,
  args: string[],
): Promise<number | undefined> {
  const [action, providerId, providerModelId] = args;
  if (action === 'discover' && providerId) {
    const listing = (await controlApiRequest(runtimeHome, {
      method: 'GET',
      path: `/v1/model-providers/${encodeURIComponent(providerId)}/models${args.includes('--refresh') ? '?refresh=true' : ''}`,
    })) as ProviderModelListing;
    console.log(formatProviderModelListing(listing));
    return 0;
  }
  if (action !== 'register' || !providerId || !providerModelId) {
    return undefined;
  }
  const alias = optionValue(args.slice(3), '--alias');
  if (!alias) {
    console.error('Model registration requires --alias <alias>.');
    return 1;
  }
  const desired = (await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: '/v1/settings/desired-state',
  })) as { revision: number };
  const result = (await controlApiRequest(runtimeHome, {
    method: 'POST',
    path: '/v1/model-registrations',
    body: {
      providerId,
      providerModelId,
      alias,
      expectedRevision: desired.revision,
    },
  })) as { revision: number; alias: string };
  console.log(
    `Registered ${result.alias} at settings revision ${result.revision}.`,
  );
  return 0;
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function formatProviderModelListing(listing: ProviderModelListing): string {
  const lines = [
    `${listing.providerLabel} models (${listing.discoverySource})`,
    ...(listing.refreshError ? [`Warning: ${listing.refreshError}`] : []),
  ];
  for (const model of listing.models) {
    const alias = model.aliases.length
      ? `aliases: ${model.aliases.join(', ')}`
      : 'not registered';
    lines.push(
      `${model.providerModelId} — ${model.displayName} — ${model.availability} — ${alias}`,
    );
  }
  if (listing.models.length === 0) {
    lines.push('No models were returned. Saved aliases were not changed.');
  }
  return lines.map(escapeTerminalControls).join('\n');
}

function escapeTerminalControls(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
