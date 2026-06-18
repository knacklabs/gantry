import type { PermissionApprovalRequest } from '../../domain/types.js';
import type { ChannelWiringDeps } from './channel-wiring-types.js';

export async function authorizeConversationApprover(input: {
  providerId: string;
  sourceAgentFolder: string;
  decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
  logger: ChannelWiringDeps['logger'];
  lookup: () => Promise<boolean>;
}): Promise<boolean> {
  if (input.decisionPolicy && input.decisionPolicy !== 'same_channel') {
    return false;
  }
  try {
    return await input.lookup();
  } catch (err) {
    input.logger.warn(
      {
        err,
        providerId: input.providerId,
        sourceAgentFolder: input.sourceAgentFolder,
      },
      'Conversation approver lookup failed',
    );
    return false;
  }
}
