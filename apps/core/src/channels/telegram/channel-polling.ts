import { createHash } from 'crypto';

import { logger } from '../../infrastructure/logging/logger.js';
import { TelegramChannelState } from './channel-state.js';

const TELEGRAM_POLL_LEASE_HASH_CHARS = 24;

export abstract class TelegramChannelPolling extends TelegramChannelState {
  protected startPolling(): void {
    if (!this.bot || this.isStopping) return;
    void this.startPollingWithLease();
  }

  private async startPollingWithLease(): Promise<void> {
    if (
      !this.bot ||
      this.isStopping ||
      this.pollingLease ||
      this.pollingStartInFlight
    ) {
      return;
    }
    this.pollingStartInFlight = true;
    if (!this.botToken.trim()) {
      this.pollingStartInFlight = false;
      logger.error('Telegram polling cannot start without a bot token');
      return;
    }
    const leaseKey = `telegram:poll:${createHash('sha256').update(this.botToken).digest('hex').slice(0, TELEGRAM_POLL_LEASE_HASH_CHARS)}`;
    let lease;
    try {
      lease = await this.opts.runtimeLease?.tryAcquire(leaseKey);
    } catch (err) {
      this.pollingStartInFlight = false;
      logger.warn(
        { err, leaseKey },
        'Telegram polling lease acquisition failed; scheduling retry',
      );
      this.schedulePollingRetry();
      return;
    }
    if (!lease && this.opts.runtimeLease) {
      this.pollingStartInFlight = false;
      logger.warn(
        { leaseKey },
        'Telegram polling lease is held by another runtime; skipping poller start',
      );
      this.schedulePollingRetry();
      return;
    }
    this.pollingLease = lease ?? null;
    lease?.onLost?.((err) => {
      if (this.pollingLease !== lease) return;
      this.pollingLease = null;
      if (this.isStopping) return;
      logger.warn(
        { err, leaseKey },
        'Telegram polling lease connection was lost; stopping poller before retry',
      );
      // bot.stop() is async and issues a final getUpdates before it settles, so chain
      // the retry off it. Otherwise a reacquired lease can start a new poll while the
      // old shutdown is still in flight — two concurrent getUpdates, and the old stop
      // can clear the new poll's abort controller.
      const stopped = this.isTelegramBotRunning()
        ? Promise.resolve(this.bot?.stop()).catch((stopErr: unknown) => {
            logger.warn(
              { err: stopErr, leaseKey },
              'Telegram poller stop failed after polling lease loss',
            );
          })
        : Promise.resolve();
      void stopped.then(() => {
        if (this.isStopping) return;
        this.schedulePollingRetry();
      });
    });

    // onLost replays synchronously, so registration above may already have handled a
    // loss and cleared pollingLease. Revalidate before falling through to the start
    // path, or we would begin polling under a lease we no longer hold.
    // Only applies when a lease was actually acquired; unleased polling (no runtime
    // lease configured) is a supported mode and must still start.
    if (lease && (this.pollingLease !== lease || !lease.isValid())) {
      this.pollingStartInFlight = false;
      logger.warn(
        { leaseKey },
        'Telegram polling lease was lost during acquisition; not starting poller',
      );
      return;
    }

    if (this.isTelegramBotRunning()) {
      this.pollingStartInFlight = false;
      logger.info(
        { leaseKey },
        'Telegram poller already running; retaining polling lease',
      );
      return;
    }

    const pollingRun = this.bot.start({
      onStart: (botInfo) => {
        logger.info(
          { username: botInfo.username, id: botInfo.id },
          'Telegram bot connected',
        );
        logger.info(
          {
            username: botInfo.username,
            hint: 'Send /chatid to the bot to get a chat registration ID',
          },
          'Telegram bot connection hint',
        );
      },
    });
    if (!pollingRun || typeof pollingRun.then !== 'function') {
      this.pollingStartInFlight = false;
      return;
    }

    Promise.resolve(pollingRun)
      .then(() => {
        this.pollingStartInFlight = false;
        if (this.isTelegramBotRunning()) {
          logger.info(
            { leaseKey },
            'Telegram poller remains active after duplicate start; retaining polling lease',
          );
          return;
        }
        void this.releasePollingLease();
        if (this.isStopping) return;
        logger.warn('Telegram polling stopped unexpectedly');
        this.schedulePollingRetry();
      })
      .catch((err) => {
        this.pollingStartInFlight = false;
        void this.releasePollingLease();
        if (this.isStopping) return;
        logger.error({ err }, 'Telegram polling failed');
        this.schedulePollingRetry();
      });
  }

  protected async releasePollingLease(): Promise<void> {
    const lease = this.pollingLease;
    this.pollingLease = null;
    await lease?.release();
  }

  private isTelegramBotRunning(): boolean {
    return this.bot?.isRunning?.() ?? false;
  }
}
