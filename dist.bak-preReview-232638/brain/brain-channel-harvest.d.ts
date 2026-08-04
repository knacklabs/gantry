import type { RuntimeSettings } from '../config/settings/runtime-settings.js';
import type { NewMessage } from '../domain/types.js';
import type { BrainService } from './brain-service.js';
export interface BrainChannelHarvestTap {
    harvest(input: {
        appId: string;
        message: NewMessage;
        settings: RuntimeSettings;
    }): Promise<void>;
}
export declare class BrainChannelHarvester implements BrainChannelHarvestTap {
    private readonly brain;
    private readonly pending;
    constructor(brain: BrainService);
    harvest(input: {
        appId: string;
        message: NewMessage;
        settings: RuntimeSettings;
    }): Promise<void>;
    private appendToPage;
}
export declare function isBrainHarvestEnabled(settings: RuntimeSettings, message: Pick<NewMessage, 'chat_jid' | 'providerAccountId'>): boolean;
