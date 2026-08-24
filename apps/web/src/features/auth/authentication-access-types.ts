export type AccessGrant = {
  id: string;
  displayName?: string | null;
  role: 'administrator' | 'viewer';
  status: 'awaiting_approval' | 'active' | 'disabled';
  updatedAt: string;
};

export type BrowserSession = {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt?: string | null;
};

export type Invitation = {
  id: string;
  invitedEmail: string;
  role: 'administrator' | 'viewer';
  expiresAt: string;
};

export type CandidateForm = {
  issuer: string;
  clientId: string;
  clientSecretRef: string;
  companyDomain: string;
  providerLabel: string;
};
