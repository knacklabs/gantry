import { ChannelOpts } from '../channel-provider.js';
import { SlackChannelDelivery } from './channel-delivery.js';
export declare class SlackChannel extends SlackChannelDelivery {
    name: string;
}
export declare function createSlackChannel(opts: ChannelOpts): Promise<SlackChannel | null>;
