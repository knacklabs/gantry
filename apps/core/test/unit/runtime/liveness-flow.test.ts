import { describe, expect, it, vi } from 'vitest';

import { createChannelWiringLiveUx } from '@core/app/bootstrap/channel-wiring-live-ux.js';
import { createLiveReactionLifecycle } from '@core/app/bootstrap/live-reaction-lifecycle.js';
import { GroupLivenessController } from '@core/runtime/group-liveness-state.js';
import { createProgressChannelSender } from '@core/runtime/group-progress-channel-sender.js';
import {
  createStatefulLivenessProgressState,
  StatefulLivenessProvider,
} from '../../harness/stateful-liveness-provider.js';

function wiringFor(provider: StatefulLivenessProvider) {
  return createChannelWiringLiveUx({
    findBinding: () => ({
      channel: provider.adapter,
      identity: provider.adapter,
    }),
    logger: { warn: vi.fn() },
  });
}

function runtimeFor(provider: StatefulLivenessProvider): ReturnType<
  typeof wiringFor
> & {
  progressCardIdentity: NonNullable<
    StatefulLivenessProvider['adapter']['progressCardIdentity']
  >;
  sendProgressUpdate: NonNullable<
    StatefulLivenessProvider['adapter']['sendProgressUpdate']
  >;
} {
  return {
    ...wiringFor(provider),
    progressCardIdentity: provider.adapter.progressCardIdentity!,
    sendProgressUpdate: provider.adapter.sendProgressUpdate!,
  };
}

function progressSenderFor(
  channelRuntime: ReturnType<typeof runtimeFor>,
  jid: string,
) {
  return createProgressChannelSender({
    channelRuntime: channelRuntime as never,
    chatJid: jid,
    groupName: 'Main Agent',
    finalizingGenerations: new Set<number>(),
    log: { warn: vi.fn() },
  });
}

describe('liveness provider-visible flow', () => {
  it('flows admission through lifecycle and wiring to one terminal provider card', async () => {
    const provider = new StatefulLivenessProvider();
    const channelRuntime = runtimeFor(provider);
    const lifecycle = createLiveReactionLifecycle({
      addReaction: channelRuntime.addReaction,
      removeReaction: channelRuntime.removeReaction,
      removalMode: channelRuntime.reactionRemovalMode('sl:C1'),
    });
    const progress = progressSenderFor(channelRuntime, 'sl:C1');
    const controller = new GroupLivenessController({
      supportsProgress: true,
      chatJid: 'sl:C1',
      groupName: 'Main Agent',
      channelRuntime: channelRuntime as never,
      buildProgressOptions: (options) => options,
      sendProgressToChannel: progress,
      onFirstProgress: lifecycle.onFirstProgress,
      onFirstVisibleOutput: lifecycle.onFirstVisibleOutput,
      onTerminal: lifecycle.onTerminal,
      log: { debug: vi.fn() },
    });

    await progress('Working');
    controller.start({ jid: 'sl:C1', messageRef: 'message-inbound' });
    await vi.waitFor(() =>
      expect(provider.reactionSet('sl:C1', 'message-inbound')).toEqual(
        new Set(['seen']),
      ),
    );
    await controller.beginVisibleDelivery();
    await controller.finishVisibleDelivery(true);
    await progress('Done.', { done: true });
    await controller.terminal();
    await vi.waitFor(() => expect(provider.typing.get('sl:C1\n')).toBe(false));

    expect(provider.cardTexts()).toEqual(['Done.']);
    expect(provider.cards.size).toBe(1);
    expect(provider.reactionSet('sl:C1', 'message-inbound')).toEqual(
      new Set(['seen']),
    );
    expect(provider.maxMutationsInFlight).toBe(1);
  });

  it('converges after failure, rate limit, and a slow stale typing settlement', async () => {
    const provider = new StatefulLivenessProvider({ typing: 'explicit' });
    const liveUx = wiringFor(provider);

    provider.failNext();
    await expect(liveUx.setTyping('sl:C1', true)).resolves.toBeUndefined();
    expect(provider.typing.has('sl:C1\n')).toBe(false);

    provider.rateLimitNext();
    await liveUx.addReaction('sl:C1', 'message-1', 'seen');
    expect(provider.reactionSet('sl:C1', 'message-1')).toEqual(
      new Set(['seen']),
    );
    expect(provider.attempts.reaction).toBe(2);

    const slow = provider.delayNext();
    const staleStart = liveUx.setTyping('sl:C1', true);
    await Promise.resolve();
    const terminalOff = liveUx.setTyping('sl:C1', false);
    slow.release();
    await Promise.all([staleStart, terminalOff]);

    expect(provider.typing.get('sl:C1\n')).toBe(false);
    expect(provider.maxMutationsInFlight).toBe(1);
  });

  it('reuses provider-visible progress state after a runtime restart without duplicating the card', async () => {
    const progressState = createStatefulLivenessProgressState();
    const beforeProvider = new StatefulLivenessProvider({ progressState });
    const beforeRuntime = runtimeFor(beforeProvider);
    const beforeRestart = progressSenderFor(beforeRuntime, 'sl:C1');
    await beforeRestart('Working');
    beforeRestart.retire();

    const afterProvider = new StatefulLivenessProvider({ progressState });
    const afterRuntime = runtimeFor(afterProvider);
    const afterRestart = progressSenderFor(afterRuntime, 'sl:C1');
    await afterRestart('Interrupted by a restart.', {
      done: true,
    });

    expect(afterProvider.cardTexts()).toEqual(['Interrupted by a restart.']);
    expect(afterProvider.cards.size).toBe(1);
  });
});
