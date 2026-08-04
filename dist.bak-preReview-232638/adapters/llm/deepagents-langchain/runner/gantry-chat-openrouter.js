import { ChatOpenRouter } from '@langchain/openrouter';
export class GantryChatOpenRouter extends ChatOpenRouter {
    #profileOverride;
    constructor(fields) {
        super(fields);
        this.#profileOverride = fields.profileOverride;
    }
    get profile() {
        return this.#profileOverride ?? super.profile;
    }
}
