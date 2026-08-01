import type { ChannelOpts } from './channel-provider.js';

export function historyCoverageInboundCallbacks(opts: ChannelOpts) {
  const providerAccountIds = () =>
    opts.inboundProviderAccountIds ??
    (opts.providerAccountId ? [opts.providerAccountId] : []);
  return {
    onInboundStateChange: (active: boolean) =>
      opts.setHistoryCoverageInboundActive?.(providerAccountIds(), active),
    onDispatchFailure: () =>
      opts.distrustHistoryCoverage?.(providerAccountIds()),
  };
}
