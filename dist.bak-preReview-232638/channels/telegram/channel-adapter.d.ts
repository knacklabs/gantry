import { ChannelOpts } from '../channel-provider.js';
import { TelegramChannelDelivery } from './channel-delivery.js';
export type TelegramChannelOpts = ChannelOpts;
export declare class TelegramChannel extends TelegramChannelDelivery {
    name: string;
}
export declare function createTelegramChannel(opts: ChannelOpts): Promise<TelegramChannel | null>;
