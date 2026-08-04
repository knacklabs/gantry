import { TelegramChannelState } from './channel-state.js';
export declare abstract class TelegramChannelPolling extends TelegramChannelState {
    protected startPolling(): void;
    private startPollingWithLease;
    protected releasePollingLease(): Promise<void>;
    private isTelegramBotRunning;
}
