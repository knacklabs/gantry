import type { RuntimeConfiguredMcpServer } from './runtime-settings-types.js';

function parseStringValue(
  raw: unknown,
  pathPrefix: string,
  fallback?: string,
): string {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${pathPrefix} must be a non-empty string`);
  }
  return raw.trim();
}

function parseOptionalStringValue(
  raw: unknown,
  pathPrefix: string,
): string | undefined {
  if (raw === undefined) return undefined;
  return parseStringValue(raw, pathPrefix);
}

function parseStringArrayValue(raw: unknown, pathPrefix: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a string array`);
  }
  return [
    ...new Set(
      raw.map((item, index) => {
        if (typeof item !== 'string' || item.trim().length === 0) {
          throw new Error(`${pathPrefix}[${index}] must be a non-empty string`);
        }
        return item.trim();
      }),
    ),
  ];
}

function parseMcpServerTransport(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredMcpServer['config']['transport'] {
  const transport = parseStringValue(raw, pathPrefix);
  if (
    transport !== 'http' &&
    transport !== 'sse' &&
    transport !== 'stdio_template'
  ) {
    throw new Error(`${pathPrefix} must be http, sse, or stdio_template`);
  }
  return transport;
}

function parseMcpCredentialRefs(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredMcpServer['credentialRefs'] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be an array`);
  }
  return raw.map((entry, index) => {
    const entryPath = `${pathPrefix}[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${entryPath} must be a mapping`);
    }
    const map = entry as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (key !== 'name' && key !== 'target' && key !== 'key') {
        throw new Error(
          `${entryPath}.${key} is not supported. Configure name, target, or key.`,
        );
      }
    }
    const target = parseStringValue(map.target, `${entryPath}.target`);
    if (target !== 'env' && target !== 'header') {
      throw new Error(`${entryPath}.target must be env or header`);
    }
    return {
      name: parseStringValue(map.name, `${entryPath}.name`),
      target,
      key: parseStringValue(map.key, `${entryPath}.key`),
    };
  });
}

function parseMcpCallerIdentity(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredMcpServer['config']['callerIdentity'] {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  const mode = parseStringValue(map.mode, `${pathPrefix}.mode`);
  if (mode !== 'disabled' && mode !== 'required') {
    throw new Error(`${pathPrefix}.mode must be disabled or required`);
  }
  const source = map.source;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error(`${pathPrefix}.source must be a mapping`);
  }
  const sourceMap = source as Record<string, unknown>;
  const kind = parseStringValue(sourceMap.kind, `${pathPrefix}.source.kind`);
  if (kind !== 'conversation_jid_phone') {
    throw new Error(`${pathPrefix}.source.kind must be conversation_jid_phone`);
  }
  return {
    mode,
    headerName: parseStringValue(
      map.headerName ?? map.header_name,
      `${pathPrefix}.headerName`,
    ),
    signingRef: parseStringValue(
      map.signingRef ?? map.signing_ref,
      `${pathPrefix}.signingRef`,
    ),
    source: {
      kind,
      jidPrefix: parseStringValue(
        sourceMap.jidPrefix ?? sourceMap.jid_prefix,
        `${pathPrefix}.source.jidPrefix`,
      ),
    },
  };
}

export function parseMcpServers(
  raw: unknown,
): Record<string, RuntimeConfiguredMcpServer> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('mcp_servers must be a mapping');
  }
  const servers: Record<string, RuntimeConfiguredMcpServer> = {};
  for (const [serverId, serverRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const pathPrefix = `mcp_servers.${serverId}`;
    if (!/^mcp:[A-Za-z0-9_.:@-]{1,128}$/.test(serverId)) {
      throw new Error(`${pathPrefix} must use a stable mcp:<id> key`);
    }
    if (
      typeof serverRaw !== 'object' ||
      serverRaw === null ||
      Array.isArray(serverRaw)
    ) {
      throw new Error(`${pathPrefix} must be a mapping`);
    }
    const map = serverRaw as Record<string, unknown>;
    const transport = parseMcpServerTransport(
      map.transport,
      `${pathPrefix}.transport`,
    );
    const config: RuntimeConfiguredMcpServer['config'] = { transport };
    if (map.url !== undefined) {
      config.url = parseStringValue(map.url, `${pathPrefix}.url`);
    }
    if (map.template_id !== undefined) {
      config.templateId = parseStringValue(
        map.template_id,
        `${pathPrefix}.template_id`,
      );
    }
    if (map.args !== undefined) {
      config.args = parseStringArrayValue(map.args, `${pathPrefix}.args`);
    }
    const callerIdentity = parseMcpCallerIdentity(
      map.callerIdentity ?? map.caller_identity,
      `${pathPrefix}.caller_identity`,
    );
    if (callerIdentity) config.callerIdentity = callerIdentity;
    const riskClass = parseStringValue(
      map.risk_class,
      `${pathPrefix}.risk_class`,
      'medium',
    );
    if (riskClass !== 'low' && riskClass !== 'medium' && riskClass !== 'high') {
      throw new Error(`${pathPrefix}.risk_class must be low, medium, or high`);
    }
    servers[serverId] = {
      name: parseStringValue(map.name, `${pathPrefix}.name`),
      displayName: parseOptionalStringValue(
        map.display_name,
        `${pathPrefix}.display_name`,
      ),
      description: parseOptionalStringValue(
        map.description,
        `${pathPrefix}.description`,
      ),
      riskClass,
      config,
      allowedToolPatterns: parseStringArrayValue(
        map.allowed_tool_patterns ?? [],
        `${pathPrefix}.allowed_tool_patterns`,
      ),
      autoApproveToolPatterns: parseStringArrayValue(
        map.auto_approve_tool_patterns ?? [],
        `${pathPrefix}.auto_approve_tool_patterns`,
      ),
      credentialRefs: parseMcpCredentialRefs(
        map.credential_refs ?? [],
        `${pathPrefix}.credential_refs`,
      ),
      sandboxProfileId: parseOptionalStringValue(
        map.sandbox_profile_id,
        `${pathPrefix}.sandbox_profile_id`,
      ),
    };
  }
  return servers;
}
