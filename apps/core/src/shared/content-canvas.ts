export const CONTENT_CANVAS_MARKDOWN_MAX_BYTES = 150 * 1024;
export const CONTENT_CANVAS_TITLE_MAX_CHARS = 300;

export const CONTENT_CANVAS_UPDATE_OPERATIONS = [
  'insert_at_start',
  'insert_at_end',
  'insert_before',
  'insert_after',
  'replace_section',
  'delete_section',
  'replace_all',
] as const;

export type ContentCanvasUpdateOperation =
  (typeof CONTENT_CANVAS_UPDATE_OPERATIONS)[number];

export type ContentCanvasAction =
  | { action: 'create'; title?: string; markdown?: string }
  | { action: 'read'; canvasHandle: string }
  | {
      action: 'update';
      canvasHandle: string;
      sectionHandle?: string;
      operation: ContentCanvasUpdateOperation;
      markdown?: string;
      confirmReplaceAll?: boolean;
      replaceAllPreflightId?: string;
    };

export interface ContentCanvasResult {
  message: string;
  canvasReadHandle?: string;
  canvasUpdateHandle?: string;
  permalink?: string;
  content?: string;
  sections?: Array<{ label: string; handle: string }>;
}

export interface ContentCanvasSurface {
  executeCanvasAction(
    conversationJid: string,
    action: ContentCanvasAction,
  ): Promise<ContentCanvasResult>;
}
