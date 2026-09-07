/**
 * The durable identity of an actor in Gantry audit and approval records.
 *
 * Agents are represented by their service-kind Person; `agentId` remains a
 * configuration identifier and is deliberately not a second principal kind.
 */
export type PrincipalRef =
  | {
      kind: 'human';
      personId: string;
      aliasId?: string;
    }
  | {
      kind: 'service';
      personId: string;
      aliasId?: string;
    }
  | {
      kind: 'system';
      source: string;
    };

export function systemPrincipal(source: string): PrincipalRef {
  const normalized = source.trim();
  if (!normalized) throw new Error('System principal source is required.');
  return { kind: 'system', source: normalized };
}

export function isPrincipalRef(value: unknown): value is PrincipalRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const principal = value as Record<string, unknown>;
  if (principal.kind === 'system') {
    return typeof principal.source === 'string' && principal.source.length > 0;
  }
  return (
    (principal.kind === 'human' || principal.kind === 'service') &&
    typeof principal.personId === 'string' &&
    principal.personId.length > 0 &&
    (principal.aliasId === undefined || typeof principal.aliasId === 'string')
  );
}
