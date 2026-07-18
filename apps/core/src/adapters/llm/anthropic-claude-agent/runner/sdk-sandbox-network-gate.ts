import { evaluateEgressDenylist } from '../../../../shared/egress-policy.js';
import { isSdkSandboxNetworkAccessToolName } from '../../../../shared/agent-tool-references.js';
import {
  normalizeEgressAuthorityHost,
  resolvePublicEgressAddress,
} from '../../../../shared/egress-target-resolution.js';

export async function decideSdkSandboxNetworkAccess(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  denylist: readonly string[];
}): Promise<
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt: false }
  | null
> {
  if (!isSdkSandboxNetworkAccessToolName(input.toolName)) return null;

  const authority =
    typeof input.toolInput.host === 'string' ? input.toolInput.host : '';
  const host = normalizeEgressAuthorityHost(authority);
  const deny = evaluateEgressDenylist({
    settings: { denylist: [...input.denylist] },
    host: host ?? authority,
  });
  if (deny) {
    return {
      behavior: 'deny',
      message: deny.reason,
      interrupt: false,
    };
  }
  // This lookup is a cheap pre-filter. Direct-mode SDK command traffic uses
  // the Gantry egress gateway as its custom sandbox proxy; the gateway repeats
  // validation and pins the resolved address when it opens the connection.
  const resolution = host
    ? await resolvePublicEgressAddress(host)
    : { ok: false as const, host: authority.trim() };
  if (!resolution.ok) {
    return {
      behavior: 'deny',
      message:
        resolution.deny?.reason ??
        `SDK sandbox network access could not safely resolve ${resolution.host || 'the requested host'}.`,
      interrupt: false,
    };
  }

  return { behavior: 'allow', updatedInput: input.toolInput };
}
