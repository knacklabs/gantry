import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type BrowserIpcAction } from '@myclaw/contracts';
import { z } from 'zod';
import { formatBrowserToolResponse } from '../formatting.js';
import { requestBrowserAction } from '../ipc.js';

type BrowserToolSchema = Record<string, z.ZodTypeAny>;

function formatBrowserFailure(action: string, error: string | undefined) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Browser ${action} failed: ${error || 'unknown error'}`,
      },
    ],
    isError: true,
  };
}

function browserTimeoutMs(args: Record<string, unknown>): number | undefined {
  const raw = args.timeout_ms;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.max(1_000, Math.min(120_000, Math.trunc(raw)));
}

function stripRuntimeArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const { timeout_ms: _timeoutMs, ...payload } = args;
  return payload;
}

async function callBrowserTool(
  action: BrowserIpcAction,
  args: Record<string, unknown>,
) {
  const timeoutMs = browserTimeoutMs(args);
  const response = await requestBrowserAction(
    action,
    stripRuntimeArgs(args),
    timeoutMs ? { timeoutMs } : undefined,
  );
  if (!response.ok) return formatBrowserFailure(action, response.error);
  if (isBrowserMcpResult(response.data)) {
    return response.data as never;
  }
  return {
    content: [
      { type: 'text' as const, text: formatBrowserToolResponse(response) },
    ],
  };
}

function isBrowserMcpResult(value: unknown): value is {
  content: Array<Record<string, unknown>>;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content);
}

function register(
  server: McpServer,
  name: BrowserIpcAction,
  description: string,
  schema: BrowserToolSchema,
): void {
  server.tool(
    name,
    `${description} Uses the host-derived MyClaw browser profile. Add timeout_ms only to change the IPC/backend deadline.`,
    { ...schema, timeout_ms: z.number().optional() },
    async (args) => callBrowserTool(name, args),
  );
}

const fileName = z
  .string()
  .optional()
  .describe('Relative file name under the run browser artifact root.');
const target = z
  .string()
  .describe(
    'Exact target element reference from browser_snapshot, or a unique selector.',
  );
const optionalTarget = target.optional();
const element = z
  .string()
  .optional()
  .describe('Human-readable element description for audit context.');

export function registerBrowserTools(server: McpServer): void {
  register(
    server,
    'browser_status',
    'Inspect browser status without launching Chrome.',
    {},
  );
  register(
    server,
    'browser_launch',
    'Launch or reuse the headed browser profile.',
    {
      headless: z.boolean().optional(),
      keep_alive_ms: z.number().optional(),
    },
  );
  register(server, 'browser_close', 'Close the browser profile session.', {});
  register(server, 'browser_navigate', 'Navigate to a URL.', {
    url: z.string(),
  });
  register(
    server,
    'browser_navigate_back',
    'Go back to the previous page.',
    {},
  );
  register(
    server,
    'browser_tabs',
    'List, create, close, or select a browser tab.',
    {
      action: z.enum(['list', 'new', 'select', 'close']),
      index: z.number().optional(),
      url: z.string().optional(),
    },
  );
  register(server, 'browser_snapshot', 'Capture an accessibility snapshot.', {
    target: optionalTarget,
    filename: fileName,
    depth: z.number().optional(),
    boxes: z.boolean().optional(),
  });
  register(server, 'browser_take_screenshot', 'Take a screenshot.', {
    element,
    target: optionalTarget,
    type: z.enum(['png', 'jpeg']).optional(),
    filename: fileName,
    fullPage: z.boolean().optional(),
  });
  register(
    server,
    'browser_console_messages',
    'Return browser console messages.',
    {
      level: z.string().optional(),
      all: z.boolean().optional(),
      filename: fileName,
    },
  );
  register(
    server,
    'browser_network_requests',
    'Return browser network requests.',
    {
      static: z.boolean().optional(),
      requestBody: z.boolean().optional(),
      requestHeaders: z.boolean().optional(),
      filter: z.string().optional(),
      filename: fileName,
    },
  );
  register(server, 'browser_click', 'Click an element.', {
    element,
    target,
    doubleClick: z.boolean().optional(),
    button: z.string().optional(),
    modifiers: z.array(z.string()).optional(),
  });
  register(server, 'browser_type', 'Type text into an editable element.', {
    element,
    target,
    text: z.string(),
    submit: z.boolean().optional(),
    slowly: z.boolean().optional(),
  });
  register(server, 'browser_press_key', 'Press a keyboard key.', {
    key: z.string(),
  });
  register(server, 'browser_hover', 'Hover over an element.', {
    element,
    target,
  });
  register(server, 'browser_drag', 'Drag between two elements.', {
    startElement: z.string().optional(),
    startTarget: z.string(),
    endElement: z.string().optional(),
    endTarget: z.string(),
  });
  register(server, 'browser_drop', 'Drop files or data onto an element.', {
    element,
    target,
    paths: z.array(z.string()).optional(),
    data: z.record(z.string(), z.string()).optional(),
  });
  register(server, 'browser_select_option', 'Select dropdown option values.', {
    element,
    target,
    values: z.array(z.string()),
  });
  register(server, 'browser_fill_form', 'Fill multiple form fields.', {
    fields: z.array(z.record(z.string(), z.unknown())),
  });
  register(server, 'browser_wait_for', 'Wait for text or time.', {
    time: z.number().optional(),
    text: z.string().optional(),
    textGone: z.string().optional(),
  });
  register(server, 'browser_evaluate', 'Evaluate JavaScript on the page.', {
    element,
    target: optionalTarget,
    function: z.string(),
    filename: fileName,
  });
  register(server, 'browser_file_upload', 'Upload one or more files.', {
    paths: z.array(z.string()).optional(),
  });
  register(server, 'browser_handle_dialog', 'Handle a browser dialog.', {
    accept: z.boolean(),
    promptText: z.string().optional(),
  });
  register(server, 'browser_resize', 'Resize the browser window.', {
    width: z.number(),
    height: z.number(),
  });
}
