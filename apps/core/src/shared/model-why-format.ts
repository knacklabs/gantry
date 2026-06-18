import { resolveModelSelection } from './model-catalog.js';
import { getModelFamily, type FamilyOrderOverrides } from './model-families.js';
import {
  describeFamilyAvailability,
  providerLabel,
} from './model-catalog-availability.js';

// `model why <alias|family>` rendering, shared by the session `/model why`
// command (runtime) and `gantry model why` (CLI/adapter). Family-aware: for a
// family it shows the members in effective order, which provider it WOULD
// resolve to for the configured set, and the reason; for a concrete alias it
// shows whether the alias's provider key is configured. Pure: the configured
// set + family order are injected. When the configured set is unavailable the
// configured/needs-key line is omitted (graceful degrade). Lives in `shared`
// so both layers may import it without a layer-boundary violation.
export function formatModelWhy(input: {
  value: string;
  configuredProviders?: Set<string>;
  familyOrder?: FamilyOrderOverrides;
}): string {
  const { value, configuredProviders, familyOrder } = input;
  const family = getModelFamily(value);
  if (family) {
    const description = describeFamilyAvailability(
      family,
      configuredProviders,
      familyOrder,
    );
    const lines = [
      `Why model family ${family.alias} (${family.displayName})`,
      `members (preference order): ${description.members
        .map((entry) => `${entry.member} [${entry.providerLabel}]`)
        .join(' > ')}`,
    ];
    if (configuredProviders === undefined) {
      lines.push(
        'resolves to: the first member whose provider key is configured (configured set unavailable here).',
      );
      return lines.join('\n');
    }
    if (description.selectedConfigured) {
      const skipped = description.members
        .filter(
          (entry) =>
            entry.member !== description.selectedMember && !entry.configured,
        )
        .map((entry) => entry.providerLabel);
      const reason = skipped.length
        ? ` (${skipped.join(', ')} not configured)`
        : '';
      lines.push(
        `resolves to: ${family.alias} → ${description.selectedMember} via ${description.selectedProviderLabel}${reason}`,
      );
    } else {
      const providers = [
        ...new Set(description.members.map((entry) => entry.providerLabel)),
      ];
      lines.push(
        `resolves to: ${family.alias} → ${description.selectedMember} via ${description.selectedProviderLabel} (no provider configured; falls back to the first member and fails loudly with its setup message)`,
        `needs a key for one of: ${providers.join(', ')}`,
      );
    }
    return lines.join('\n');
  }

  const resolved = resolveModelSelection(value);
  if (!resolved.ok) {
    return `Unknown model "${value}". Use /models to view supported aliases and families.`;
  }
  const providerId = resolved.entry.modelRoute.id;
  const lines = [
    `Why model ${resolved.alias} (${resolved.entry.displayName})`,
    `provider: ${resolved.entry.modelRoute.label}`,
    `response family: ${resolved.entry.responseFamily}`,
  ];
  if (configuredProviders !== undefined) {
    lines.push(
      configuredProviders.has(providerId)
        ? `credential: ${providerLabel(providerId)} key is configured (available now)`
        : `credential: needs ${providerLabel(providerId)} key`,
    );
  }
  return lines.join('\n');
}

// Surfaced for tests / callers that want only the resolved provider id of a
// concrete or family alias under a configured set.
export function resolvedProviderIdForWhy(input: {
  value: string;
  configuredProviders?: Set<string>;
  familyOrder?: FamilyOrderOverrides;
}): string | undefined {
  const family = getModelFamily(input.value);
  if (family) {
    return describeFamilyAvailability(
      family,
      input.configuredProviders,
      input.familyOrder,
    ).selectedProviderId;
  }
  const resolved = resolveModelSelection(input.value);
  return resolved.ok ? resolved.entry.modelRoute.id : undefined;
}
