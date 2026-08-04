import { App } from '@slack/bolt';
export declare function connectSlackApp(input: {
    botToken: string;
    appToken: string;
    inboundEnabled: boolean;
    interactionCallbacksEnabled: boolean;
    registerBoltHandlers: (app: App) => void;
}): Promise<{
    app: App;
    botUserId: string | null;
}>;
