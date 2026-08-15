import { logger } from '../infrastructure/logging/logger.js';
import type { ChannelOpts } from './channel-provider.js';
import { TeamsChannel } from './teams.js';
import { createMicrosoftTeamsSdkClient } from './teams-sdk-client.js';
import {
  readTeamsCredentials,
  type TeamsChannelDependencies,
} from './teams-types.js';

export async function createTeamsChannel(
  opts: ChannelOpts,
  deps: TeamsChannelDependencies = {},
): Promise<TeamsChannel | null> {
  const credentials =
    deps.credentials ??
    (await readTeamsCredentials(
      opts.runtimeSecrets,
      opts.runtimeSettings?.(),
      opts.providerAccountId,
    ));
  if (!credentials) {
    logger.warn(
      'Teams: TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET, and TEAMS_TENANT_ID are required',
    );
    return null;
  }
  const sdkClient =
    deps.sdkClient ?? createMicrosoftTeamsSdkClient(credentials);
  if (!sdkClient) {
    logger.warn(
      'Teams: Microsoft Teams SDK transport is not configured for this scaffold',
    );
    return null;
  }
  return new TeamsChannel(credentials, opts, sdkClient);
}
