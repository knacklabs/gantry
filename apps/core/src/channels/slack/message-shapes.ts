import type { SlackCanvasFileLike } from './canvas-support.js';

export interface SlackMessageLike {
  channel?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  deleted_ts?: string;
  previous_message?: {
    ts?: string;
    thread_ts?: string;
  };
  text?: string;
  files?: SlackCanvasFileLike[];
  client_msg_id?: string;
  edited?: unknown;
}
