import {
  CONTENT_CANVAS_MARKDOWN_MAX_BYTES,
  CONTENT_CANVAS_TITLE_MAX_CHARS,
  CONTENT_CANVAS_UPDATE_OPERATIONS,
  type ContentCanvasAction,
  type ContentCanvasResult,
  type ContentCanvasUpdateOperation,
} from '../shared/content-canvas.js';
import { createTaskResponder } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';

type CanvasActionPort = (input: {
  conversationJid: string;
  providerAccountId: string;
  action: ContentCanvasAction;
}) => Promise<ContentCanvasResult>;

let executeCanvasAction: CanvasActionPort | undefined;

export function configureCanvasIpcHandlers(
  port: CanvasActionPort | undefined,
): void {
  executeCanvasAction = port;
}

const canvasHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolderJids } = context;
  const { acceptData, reject } = createTaskResponder(
    context.sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  if (!data.appId || !data.providerAccountId) {
    reject('Canvas tools require signed app and provider scope.', 'forbidden');
    return;
  }
  if (
    !data.chatJid?.startsWith('sl:') ||
    data.targetJid !== data.chatJid ||
    !sourceAgentFolderJids.includes(data.chatJid)
  ) {
    reject(
      'Canvas tools must use the originating provider conversation.',
      'forbidden',
    );
    return;
  }
  if (!executeCanvasAction) {
    reject('Canvas adapter is not ready.', 'preflight_failed');
    return;
  }

  let action: ContentCanvasAction;
  try {
    action = parseCanvasAction(data.type, data.payload);
  } catch (error) {
    reject(boundedError(error, 'Invalid canvas request.'), 'invalid_request');
    return;
  }

  try {
    const result = await executeCanvasAction({
      conversationJid: data.chatJid,
      providerAccountId: data.providerAccountId,
      action,
    });
    acceptData(result.message, result);
  } catch (error) {
    reject(boundedError(error, 'Canvas request failed.'), 'provider_error');
  }
};

export const canvasTaskHandlers: Record<string, TaskHandler> = {
  canvas_create: canvasHandler,
  canvas_read: canvasHandler,
  canvas_update: canvasHandler,
};

export function parseCanvasAction(
  type: string,
  payload: Record<string, unknown> | undefined,
): ContentCanvasAction {
  const value = strictRecord(payload, 'Canvas payload');
  if (type === 'canvas_create') {
    assertOnlyKeys(value, ['title', 'markdown']);
    const title = optionalString(value.title, 'title');
    const markdown = optionalString(value.markdown, 'markdown', true);
    if (title && [...title].length > CONTENT_CANVAS_TITLE_MAX_CHARS) {
      throw new Error(
        `title must be at most ${CONTENT_CANVAS_TITLE_MAX_CHARS} characters.`,
      );
    }
    assertMarkdownBound(markdown);
    return {
      action: 'create',
      ...(title !== undefined ? { title } : {}),
      ...(markdown !== undefined ? { markdown } : {}),
    };
  }
  if (type === 'canvas_read') {
    assertOnlyKeys(value, ['canvas_handle']);
    return {
      action: 'read',
      canvasHandle: requiredString(value.canvas_handle, 'canvas_handle'),
    };
  }
  if (type !== 'canvas_update') {
    throw new Error(`Unsupported canvas action: ${type}`);
  }

  assertOnlyKeys(value, [
    'canvas_handle',
    'section_handle',
    'operation',
    'markdown',
    'confirm_replace_all',
    'replace_all_preflight_id',
  ]);
  const canvasHandle = requiredString(value.canvas_handle, 'canvas_handle');
  const sectionHandle = optionalString(value.section_handle, 'section_handle');
  const operation = requiredString(value.operation, 'operation');
  if (
    !(CONTENT_CANVAS_UPDATE_OPERATIONS as readonly string[]).includes(operation)
  ) {
    throw new Error(`Unknown canvas operation: ${operation}.`);
  }
  const typedOperation = operation as ContentCanvasUpdateOperation;
  const markdown = optionalString(value.markdown, 'markdown', true);
  const deleteSection = operation === 'delete_section';
  if (!deleteSection && markdown === undefined) {
    throw new Error(`markdown is required for ${operation}.`);
  }
  if (deleteSection && markdown !== undefined) {
    throw new Error('delete_section does not accept markdown.');
  }
  assertMarkdownBound(markdown);
  const sectionRequired = [
    'insert_before',
    'insert_after',
    'replace_section',
    'delete_section',
  ].includes(operation);
  if (sectionRequired && !sectionHandle) {
    throw new Error(`${operation} requires section_handle.`);
  }
  if (!sectionRequired && sectionHandle) {
    throw new Error(`${operation} does not accept section_handle.`);
  }
  const confirmReplaceAll = optionalBoolean(
    value.confirm_replace_all,
    'confirm_replace_all',
  );
  if (operation !== 'replace_all' && confirmReplaceAll !== undefined) {
    throw new Error('confirm_replace_all is valid only for replace_all.');
  }
  const replaceAllPreflightId = optionalString(
    value.replace_all_preflight_id,
    'replace_all_preflight_id',
  );
  if (operation !== 'replace_all' && replaceAllPreflightId !== undefined) {
    throw new Error('replace_all_preflight_id is valid only for replace_all.');
  }
  return {
    action: 'update',
    canvasHandle,
    operation: typedOperation,
    ...(sectionHandle ? { sectionHandle } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
    ...(confirmReplaceAll !== undefined ? { confirmReplaceAll } : {}),
    ...(replaceAllPreflightId !== undefined ? { replaceAllPreflightId } : {}),
  };
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown canvas field(s): ${unknown.sort().join(', ')}.`);
  }
}

function requiredString(value: unknown, label: string): string {
  const parsed = optionalString(value, label);
  if (!parsed) throw new Error(`${label} is required.`);
  return parsed;
}

function optionalString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  if (allowEmpty) return value;
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty.`);
  return trimmed;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  return value;
}

function assertMarkdownBound(markdown: string | undefined): void {
  if (
    markdown !== undefined &&
    Buffer.byteLength(markdown, 'utf8') > CONTENT_CANVAS_MARKDOWN_MAX_BYTES
  ) {
    throw new Error(
      `markdown must be at most ${CONTENT_CANVAS_MARKDOWN_MAX_BYTES} UTF-8 bytes.`,
    );
  }
}

function boundedError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return Buffer.from(message, 'utf8').subarray(0, 1_500).toString('utf8');
}
