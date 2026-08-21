import {
  createLiveUxDispatcher,
  type LiveUxBinding,
} from '../../runtime/live-ux-dispatcher.js';
import type { ChannelAccountOptions } from './channel-wiring-types.js';

export function createChannelWiringLiveUx(input: {
  findBinding: (
    jid: string,
    providerAccountId?: string,
  ) => LiveUxBinding | undefined;
  logger: Parameters<typeof createLiveUxDispatcher>[0]['logger'];
}) {
  return createLiveUxDispatcher({
    findBinding: input.findBinding,
    logger: input.logger,
  }) satisfies {
    setTyping(
      jid: string,
      isTyping: boolean,
      options?: ChannelAccountOptions,
    ): Promise<void>;
  };
}
