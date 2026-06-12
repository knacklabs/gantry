// Fixed-image worker product mode: a worker reports the immutable capability
// inventory baked into its image/build at startup. The inventory is evidence of
// availability (what the image can run), not authority (what an agent may use).
// Run admission compares an agent's selected capabilities against this inventory
// and fails closed when a selected capability is not present in the image.
export const IMAGE_CAPABILITIES_ENV = 'GANTRY_IMAGE_CAPABILITIES_JSON';

// Parse a declared image capability inventory from its raw JSON env value.
// Malformed declarations fail closed to an empty inventory.
export function parseImageCapabilityInventory(
  raw: string | undefined,
): string[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = new Set<string>();
  for (const item of parsed) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

export function readImageCapabilityInventory(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  return Object.hasOwn(env, IMAGE_CAPABILITIES_ENV)
    ? parseImageCapabilityInventory(env[IMAGE_CAPABILITIES_ENV])
    : undefined;
}

// Selected capability ids not present in the image inventory.
export function missingImageCapabilities(
  selected: readonly { capabilityId: string }[],
  inventory: readonly string[],
): string[] {
  const available = new Set(inventory);
  const missing = new Set<string>();
  for (const capability of selected) {
    if (!available.has(capability.capabilityId)) {
      missing.add(capability.capabilityId);
    }
  }
  return [...missing].sort();
}

export function fixedImageSetupRequiredMessage(
  missing: readonly string[],
): string {
  const isSingle = missing.length === 1;
  return `Setup required: the selected ${
    isSingle ? 'capability is' : 'capabilities are'
  } not available in this worker image: ${missing.join(', ')}. Rebuild or deploy a worker image that includes ${
    isSingle ? 'it' : 'them'
  }, or deselect ${isSingle ? 'it' : 'them'} for this agent.`;
}
