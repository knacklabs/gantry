export type {
  Job,
  JobEvent,
  JobRun,
  NewMessage,
  ConversationRoute,
} from '../types.js';
export type {
  MemoryChunk,
  MemoryItem,
  MemoryProcedure,
  MemoryScope,
  MemorySearchResult,
  SimilarMemoryItemMatch,
} from '../../memory/memory-types.js';

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}
