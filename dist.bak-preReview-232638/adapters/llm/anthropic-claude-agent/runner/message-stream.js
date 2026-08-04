/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
export class MessageStream {
    queue = [];
    waiting = null;
    done = false;
    pushInitialPrompt(prompt, memoryContext) {
        this.pushContent(memoryContext
            ? [
                { type: 'text', text: memoryContext },
                { type: 'text', text: prompt },
            ]
            : prompt);
    }
    pushContent(content) {
        this.queue.push({
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
            session_id: '',
        });
        this.waiting?.();
    }
    end() {
        this.done = true;
        this.waiting?.();
    }
    async *[Symbol.asyncIterator]() {
        while (true) {
            while (this.queue.length > 0) {
                yield this.queue.shift();
            }
            if (this.done)
                return;
            await new Promise((r) => {
                this.waiting = r;
            });
            this.waiting = null;
        }
    }
}
