import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  getKnownBrowserStatus,
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
    browserProfileName?: string;
  },
  adapters: {
    browserSkillSource: SkillSourceT;
    actionMcpServerName: string;
    createActionMcpServerConfig: (
      cdpEndpoint: string,
    ) => MaterializedMcpCapability['config'];
  },
): AgentBrowserRunWiring<SkillSourceT> {
  const browserProfileName =
    input.browserProfileName || DEFAULT_BROWSER_PROFILE_NAME;
  return {
    skillSources: [adapters.browserSkillSource],
    activate: async () => {
      let session: ReturnType<typeof getKnownBrowserStatus>;
      try {
        session = getKnownBrowserStatus(browserProfileName);
      } catch (err) {
        return {
          env: {},
          mcpCapabilities: [],
          runtimeDetails: [
            `browserProfile=${browserProfileName}`,
            `browserStatus=unavailable:${err instanceof Error ? err.message : String(err)}`,
          ],
        };
      }
      if (!session.running || !session.cdpReady || !session.port) {
        return {
          env: {},
          mcpCapabilities: [],
          runtimeDetails: [
            `browserProfile=${browserProfileName}`,
            'browserStatus=stopped',
          ],
        };
      }
      const env: Record<string, string> = {};
      applyLoopbackNoProxyEnv(env);
      const cdpEndpoint = `http://127.0.0.1:${session.port}`;

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
          `browserProfile=${browserProfileName}`,
          'browserActionMcp=ready',
          `browserHeadless=${session.headless === true}`,
        ],
      };
    },
  };
}
