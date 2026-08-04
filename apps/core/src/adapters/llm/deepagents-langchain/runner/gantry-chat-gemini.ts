import {
  ChatOpenAI,
  ChatOpenAICompletions,
  type ChatOpenAIFields,
} from '@langchain/openai';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

// Gemini 3 requires every function call's extra_content thought signature to
// be replayed on the next request. LangChain parses tool calls for execution,
// but its normal OpenAI serializer then rebuilds them and drops that metadata.
// Project a request-only copy with parsed calls cleared so the preserved raw
// additional_kwargs.tool_calls are sent unchanged.
class SignaturePreservingGeminiCompletions extends ChatOpenAICompletions {
  override _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return super._generate(
      preserveGeminiThoughtSignatures(messages),
      options,
      runManager,
    );
  }
}

export class GantryChatGemini extends ChatOpenAI {
  constructor(fields: ChatOpenAIFields) {
    super({
      ...fields,
      completions: new SignaturePreservingGeminiCompletions(fields),
    });
  }
}

export function preserveGeminiThoughtSignatures(
  messages: readonly BaseMessage[],
): BaseMessage[] {
  return messages.map((message) => {
    if (
      !AIMessage.isInstance(message) ||
      !Array.isArray(message.additional_kwargs.tool_calls)
    ) {
      return message;
    }
    return new AIMessage({
      content: message.content,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      id: message.id,
      name: message.name,
      tool_calls: [],
      invalid_tool_calls: message.invalid_tool_calls,
      usage_metadata: message.usage_metadata,
    });
  });
}
