export interface SDKTextBlock {
  type: 'text';
  text: string;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | SDKTextBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  pushInitialPrompt(prompt: string, memoryContext?: string): void {
    this.pushContent(
      memoryContext
        ? [
            { type: 'text', text: memoryContext },
            { type: 'text', text: prompt },
          ]
        : prompt,
    );
  }

  pushContent(content: string | SDKTextBlock[]): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}
