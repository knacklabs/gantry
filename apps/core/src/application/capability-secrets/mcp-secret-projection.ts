import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerId } from '../../domain/mcp/mcp-servers.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
} from '../../domain/ports/repositories.js';
import { CapabilitySecretService } from './capability-secret-service.js';

/** Reads a single runtime-owned secret by name (e.g. from $GANTRY_HOME/.env). */
export type RuntimeEnvReader = (name: string) => string;

/** Minimal structural logger so this layer needs no infrastructure import. */
export interface CredentialResolutionLogger {
  error: (data: Record<string, unknown>, message: string) => void;
}

export async function resolveMcpCredentialEnvForAgent(input: {
  appId: AppId;
  agentId: AgentId;
  mcpServers: McpServerRepository;
  secrets: CapabilitySecretRepository;
  serverIds?: readonly McpServerId[];
  // Required: callers MUST inject the runtime-env reader (e.g.
  // runtimeEnvValueDynamic). http/sse signing secrets live in
  // $GANTRY_HOME/.env, not process.env — a process.env default would silently
  // resolve empty in core and break caller-identity signing, so the type
  // system forces every call site to wire the real reader.
  readRuntimeEnv: RuntimeEnvReader;
  logger?: CredentialResolutionLogger;
}): Promise<Record<string, string>> {
  const readRuntimeEnv = input.readRuntimeEnv;
  const records = await input.mcpServers.listMaterializedServersForAgent({
    appId: input.appId,
    agentId: input.agentId,
    ...(input.serverIds ? { serverIds: input.serverIds } : {}),
  });
  const service = new CapabilitySecretService(input.secrets);
  const credentialEnv: Record<string, string> = {};
  for (const record of records) {
    const config = record.definition.config;
    const identity = config.callerIdentity;
    const isRemoteTransport =
      config.transport === 'http' || config.transport === 'sse';

    if (isRemoteTransport) {
      // External connectors own their credentials in their own .env; core never
      // injects env into them and ignores their (env-targeted) credential_refs.
      // The only secret core needs is the shared caller-identity signing key,
      // read from runtime env — the connector verifies with the same value.
      if (identity?.mode === 'required') {
        const value = readRuntimeEnv(identity.signingRef);
        if (value) {
          credentialEnv[identity.signingRef] = value;
        } else {
          input.logger?.error(
            { server: record.definition.name, signingRef: identity.signingRef },
            'mcp_signing_secret_missing_from_env',
          );
        }
      }
      continue;
    }

    // stdio_template servers are spawned by core, which injects their env from
    // the reviewed capability secret store.
    const refs = [
      ...record.definition.credentialRefs.map((ref) => ref.name),
      ...(identity?.mode === 'required' ? [identity.signingRef] : []),
    ];
    if (refs.length === 0) continue;
    const resolved = await service.resolveEnv({
      appId: input.appId,
      names: refs,
      allowedCapabilityIds: [
        record.definition.id,
        `mcp:${record.definition.name}`,
      ],
    });
    Object.assign(credentialEnv, resolved.env);
  }
  return credentialEnv;
}
