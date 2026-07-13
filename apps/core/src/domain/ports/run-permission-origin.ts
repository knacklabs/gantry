export interface RunPermissionOrigin {
  runId: string;
  appId: string;
  agentFolder: string;
  targetJid?: string;
  providerAccountId?: string;
  threadId?: string;
  triggeringSenderId?: string;
  senderIsApprover: boolean;
  triggeringMessageTimestamp?: string;
  triggeringMessageId?: string;
  isScheduled: boolean;
  createdAt: string;
}

export interface RunPermissionOriginRepository {
  upsertRunOrigin(origin: RunPermissionOrigin): Promise<void>;
  getRunOrigin(runId: string): Promise<RunPermissionOrigin | null>;
}
