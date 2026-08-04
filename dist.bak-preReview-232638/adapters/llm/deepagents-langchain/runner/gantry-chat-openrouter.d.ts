import { ChatOpenRouter } from '@langchain/openrouter';
import type { ChatOpenRouterInput } from '@langchain/openrouter';
import type { ModelProfile } from '@langchain/core/language_models/profile';
export interface GantryChatOpenRouterFields extends ChatOpenRouterInput {
    profileOverride?: ModelProfile;
}
export declare class GantryChatOpenRouter extends ChatOpenRouter {
    #private;
    constructor(fields: GantryChatOpenRouterFields);
    get profile(): ModelProfile;
}
