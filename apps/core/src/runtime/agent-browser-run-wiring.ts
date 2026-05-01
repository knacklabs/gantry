import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  getBrowserStatus,
} from './browser-capability.js';
import { applyLoopbackNoProxyEnv } from '../shared/no-proxy.js';

export type RuntimeMcpCapabilityProjection = MaterializedMcpCapability;

export interface AgentBrowserRunWiring<SkillSourceT> {
  skillSources: readonly SkillSourceT[];
  activate(): Promise<{
    env: Record<string, string>;
    mcpCapabilities: readonly RuntimeMcpCapabilityProjection[];
    runtimeDetails: readonly string[];
  }>;
}

export function createAgentBrowserRunWiring<SkillSourceT>(
  input: {
    isMain: boolean;
  },
  adapters: {
    browserSkillSource: SkillSourceT;
    actionMcpServerName: string;
    createActionMcpServerConfig: (
      cdpEndpoint: string,
    ) => MaterializedMcpCapability['config'];
  },
): AgentBrowserRunWiring<SkillSourceT> {
  if (!input.isMain) {
    return {
      skillSources: [],
      activate: async () => ({
        env: {},
        mcpCapabilities: [],
        runtimeDetails: [],
      }),
    };
  }

  return {
    skillSources: [adapters.browserSkillSource],
    activate: async () => {
      let session: Awaited<ReturnType<typeof getBrowserStatus>>;
      try {
        session = await getBrowserStatus(DEFAULT_BROWSER_PROFILE_NAME);
      } catch (err) {
        return {
          env: {},
          mcpCapabilities: [],
          runtimeDetails: [
            `browserProfile=${DEFAULT_BROWSER_PROFILE_NAME}`,
            `browserStatus=unavailable:${err instanceof Error ? err.message : String(err)}`,
          ],
        };
      }
      if (!session.running || !session.cdpReady || !session.port) {
        return {
          env: {},
          mcpCapabilities: [],
          runtimeDetails: [
            `browserProfile=${DEFAULT_BROWSER_PROFILE_NAME}`,
            'browserStatus=stopped',
          ],
        };
      }
      const cdpEndpoint = `http://127.0.0.1:${session.port}`;
      const env: Record<string, string> = {
        PLAYWRIGHT_MCP_CDP_ENDPOINT: cdpEndpoint,
      };
      applyLoopbackNoProxyEnv(env);

      return {
        env,
        mcpCapabilities: [
          {
            name: adapters.actionMcpServerName,
            config: adapters.createActionMcpServerConfig(cdpEndpoint),
            allowedToolPatterns: ['*'],
            autoApproveToolPatterns: [],
            allowedToolNames: [`mcp__${adapters.actionMcpServerName}__*`],
            autoApproveToolNames: [],
            required: false,
          },
        ],
        runtimeDetails: [
          `browserProfile=${DEFAULT_BROWSER_PROFILE_NAME}`,
          `browserCdp=${cdpEndpoint}`,
          `browserHeadless=${session.headless === true}`,
        ],
      };
    },
  };
}
