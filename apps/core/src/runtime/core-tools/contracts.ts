import type { CoreToolInputSchema } from './schemas.js';

export interface McpCompatibleToolError {
  category: 'transient' | 'validation' | 'business' | 'permission';
  isRetryable: boolean;
  message: string;
}

export interface McpCompatibleToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  error?: McpCompatibleToolError;
}

export interface CoreToolHandlerContext {
  signal?: AbortSignal;
}

export interface CoreToolDefinition {
  name: string;
  description: string;
  inputSchema: CoreToolInputSchema<Record<string, unknown>>;
  handler: (
    input: Record<string, unknown>,
    context?: CoreToolHandlerContext,
  ) => Promise<McpCompatibleToolResult>;
}
