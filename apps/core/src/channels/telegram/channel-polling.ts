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
        'Telegram polling lease connection was lost; scheduling retry',
      );
      this.schedulePollingRetry();
    });

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
