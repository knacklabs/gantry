type TransportLike = {
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<T>;
};

export type RuntimeSettingsResponse = {
  settings: {
    desiredState: {
      authoritative: boolean;
    };
    agent: {
      name: string;
      defaultModel: string;
      oneTimeJobDefaultModel: string;
      recurringJobDefaultModel: string;
    };
    agents: Record<
      string,
      {
        name: string;
        folder: string;
        persona?:
          | 'developer'
          | 'generalist'
          | 'sales'
          | 'marketing'
          | 'operations'
          | 'research';
        relationshipMode?: 'personal' | 'organization';
        model?: string;
        oneTimeJobDefaultModel?: string;
        recurringJobDefaultModel?: string;
        bindings: Record<
          string,
          {
            jid: string;
            provider?: string;
            name?: string;
            threadId?: string;
            trigger: string;
            addedAt: string;
            requiresTrigger: boolean;
            model?: string;
          }
        >;
        sources: {
          skills: Array<{
            name?: string;
            id: string;
            version?: string;
            kind?: string;
          }>;
          mcpServers: Array<{
            name?: string;
            id: string;
            version?: string;
            kind?: string;
          }>;
          tools: Array<{
            name?: string;
            id: string;
            version?: string;
            kind?: string;
          }>;
        };
        capabilities: Array<{
          id: string;
          version: string;
        }>;
        access?: {
          preset: 'full' | 'locked';
        };
      }
    >;
    memory: {
      enabled: boolean;
      dreaming: {
        enabled: boolean;
      };
    };
    observer: {
      enabled: boolean;
      owner?: {
        recipient: string;
        conversation: string;
      };
    };
    runtime: {
      queue: {
        maxMessageRuns: number;
        maxJobRuns: number;
        maxMessageBacklog: number;
        maxTaskBacklog: number;
        maxRetries: number;
        baseRetryMs: number;
        drainDeadlineMs: number;
      };
      sandbox: {
        provider: 'direct' | 'sandbox_runtime';
        resourceLimits: {
          cpuSeconds: number;
          memoryMb: number;
          maxProcesses: number;
        };
      };
      artifactStore: {
        driver: 'local' | 's3';
        bucket?: string;
        region?: string;
        endpoint?: string;
        forcePathStyle?: boolean;
      };
      deploymentMode: 'workstation' | 'fleet';
    };
    browser: {
      usage: {
        enabled: boolean;
        mode: 'audit' | 'enforce';
        windowMs: number;
        maxActionsPerWindow: number;
        maxConcurrentPerSite: number;
      };
    };
    permissions: {
      yoloMode: {
        enabled: boolean;
        denylist: string[];
        denylistPaths: string[];
      };
      egress: {
        denylist: string[];
      };
    };
  };
};

/**
 * The typed JSON settings document carried by the desired-state API. Mirrors the
 * `@gantry/contracts` `SettingsDocument` type (the SDK hand-mirrors contracts
 * shapes rather than depending on the package). YAML is the human file format
 * for the workstation file and CLI `--file` edge only and never appears here;
 * authoritative document-path-level validation runs server-side.
 */
export type SettingsDocument = Record<string, unknown>;

export type DesiredStateResponse = {
  revision: number;
  minReaderVersion?: number;
  settings: SettingsDocument | null;
  createdBy?: string;
  note?: string | null;
  updatedAt: string | null;
};

export type DesiredStateUpdateRequest = {
  settings: SettingsDocument;
  expectedRevision?: number | null;
  note?: string | null;
};

export type DesiredStateUpdateResponse = {
  revision: number;
};

export type SettingsRevisionSummary = {
  revision: number;
  minReaderVersion: number;
  createdBy: string;
  note: string | null;
  createdAt: string;
};

export type SettingsRevisionsResponse = {
  revisions: SettingsRevisionSummary[];
};

export function createSettingsClient(transport: TransportLike) {
  return {
    get: () =>
      transport.request<RuntimeSettingsResponse>({
        method: 'GET',
        path: '/v1/settings',
      }),
    getDesiredState: () =>
      transport.request<DesiredStateResponse>({
        method: 'GET',
        path: '/v1/settings/desired-state',
      }),
    updateDesiredState: (body: DesiredStateUpdateRequest) =>
      transport.request<DesiredStateUpdateResponse>({
        method: 'PUT',
        path: '/v1/settings/desired-state',
        body,
      }),
    listRevisions: () =>
      transport.request<SettingsRevisionsResponse>({
        method: 'GET',
        path: '/v1/settings/revisions',
      }),
  };
}
