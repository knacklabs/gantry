export interface PermissionPromotionCounter {
  appId: string;
  agentFolder: string;
  suggestionKey: string;
  allowCount: number;
  deniedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionPromotionRepository {
  incrementAndGet(input: {
    appId: string;
    agentFolder: string;
    suggestionKey: string;
    nowIso: string;
  }): Promise<PermissionPromotionCounter>;

  get(input: {
    appId: string;
    agentFolder: string;
    suggestionKey: string;
  }): Promise<PermissionPromotionCounter | null>;

  markDenied(input: {
    appId: string;
    agentFolder: string;
    suggestionKey: string;
    nowIso: string;
  }): Promise<void>;
}
