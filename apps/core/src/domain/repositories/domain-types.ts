export type {
  Job,
  JobAccessRequirement,
  JobCapabilityRequirement,
  JobCapabilityRequirementImplementation,
  JobEvent,
  JobRun,
  NewMessage,
  ConversationRoute,
} from '../types.js';
export type {
  MemoryScope,
  MemorySearchResult,
} from '../../memory/memory-types.js';

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}
