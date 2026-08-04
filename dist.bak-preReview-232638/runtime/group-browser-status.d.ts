import type { BrowserStatusSnapshot } from '../session/session-command-format.js';
interface BrowserStatusGroup {
    name: string;
    folder: string;
    conversationKind?: 'dm' | 'channel';
}
export declare function getGroupBrowserStatus(input: {
    group: BrowserStatusGroup;
    chatJid: string;
}): Promise<BrowserStatusSnapshot>;
export {};
