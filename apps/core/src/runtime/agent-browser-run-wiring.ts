import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  ensureBrowserReady,
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
    headless?: boolean;
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
      const session = await ensureBrowserReady({
        profileName: DEFAULT_BROWSER_PROFILE_NAME,
        headless: input.headless,
      });
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
            allowedToolNames: [`mcp__${adapters.actionMcpServerName}__*`],
            autoApproveToolNames: [],
            required: false,
          },
        ],
        runtimeDetails: [
          `browserProfile=${DEFAULT_BROWSER_PROFILE_NAME}`,
          `browserCdp=${cdpEndpoint}`,
          `browserHeadless=${input.headless === true}`,
        ],
      };
    },
  };
}
