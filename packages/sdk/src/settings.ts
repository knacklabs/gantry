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
        model?: string;
        oneTimeJobDefaultModel?: string;
        recurringJobDefaultModel?: string;
        bindings: Record<
          string,
          {
            jid: string;
            provider?: string;
            name?: string;
            trigger: string;
            addedAt: string;
            requiresTrigger: boolean;
            model?: string;
          }
        >;
        capabilities: {
          toolIds: string[];
          skillIds: string[];
          mcpServerIds: string[];
        };
      }
    >;
    memory: {
      enabled: boolean;
      dreaming: {
        enabled: boolean;
      };
    };
    runtime: {
      queue: {
        maxMessageRuns: number;
        maxJobRuns: number;
        maxRetries: number;
        baseRetryMs: number;
      };
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

export function createSettingsClient(transport: TransportLike) {
  return {
    get: () =>
      transport.request<RuntimeSettingsResponse>({
        method: 'GET',
        path: '/v1/settings',
      }),
  };
}
