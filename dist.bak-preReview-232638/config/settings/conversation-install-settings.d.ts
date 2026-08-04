import type { Conversation } from '../../domain/conversation/conversation.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
export declare function applyConversationInstallToSettings(input: {
    settings: RuntimeSettings;
    conversation: Pick<Conversation, 'id' | 'externalRef' | 'kind' | 'title'>;
    providerAccountId: string;
    agentFolder: string;
    controlApprovers: readonly string[];
    now: string;
}): string;
