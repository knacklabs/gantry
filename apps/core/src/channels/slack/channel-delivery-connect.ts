import type { App } from '@slack/bolt';

import type { ChannelOpts } from '../channel-provider.js';
import { historyCoverageInboundCallbacks } from '../conversation-history-coverage-lifecycle.js';
import { connectSlackApp } from './channel-connect.js';
import type { SlackMessageLike } from './message-shapes.js';
import { createSlackIngressReplayScheduler } from './reconnect-replay.js';

export async function connectSlackDelivery(input: {
  botToken: string;
  appToken: string;
  opts: ChannelOpts;
  options: { inbound?: boolean; interactionCallbacks?: boolean };
  app: () => App | null;
  registerBoltHandlers: (app: App, inbound: boolean) => void;
  ingest: (message: SlackMessageLike) => Promise<void>;
}) {
  const inboundEnabled = input.options.inbound !== false;
  const interactionCallbacksEnabled =
    input.options.interactionCallbacks ?? inboundEnabled;
  const historyCallbacks = historyCoverageInboundCallbacks(input.opts);
  let replay: ReturnType<typeof createSlackIngressReplayScheduler> | null =
    null;
  const connected = await connectSlackApp({
    botToken: input.botToken,
    appToken: input.appToken,
    inboundEnabled,
    interactionCallbacksEnabled,
    onReconnect: () =>
      input.opts.distrustHistoryCoverage?.(
        input.opts.inboundProviderAccountIds ??
          (input.opts.providerAccountId ? [input.opts.providerAccountId] : []),
      ),
    onInboundStateChange: (active) => {
      historyCallbacks.onInboundStateChange(active);
      if (active) replay?.schedule();
    },
    onDispatchFailure: historyCallbacks.onDispatchFailure,
    registerBoltHandlers: (app) =>
      input.registerBoltHandlers(app, inboundEnabled),
  });
  const recovery = input.opts.conversationIngressRecovery;
  const providerAccountId = input.opts.providerAccountId;
  if (inboundEnabled && recovery && providerAccountId) {
    replay = createSlackIngressReplayScheduler({
      app: input.app,
      providerAccountId,
      recovery,
      ingest: input.ingest,
    });
    replay.schedule();
  }
  return { connected, interactionCallbacksEnabled, replay };
}
