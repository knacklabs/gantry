export interface LaunchBrowserOptions {
  profileName?: string;
  headless?: boolean;
  keepAliveMs?: number;
}

export interface BrowserSessionStatus {
  profile: string;
  profileName: string;
  running: boolean;
  cdpReady: boolean;
  cdpUrl?: string;
  port?: number;
  pid?: number;
  targetId?: string;
  lastUsedAt?: string;
  headless?: boolean;
  keepAliveMs?: number;
  idleExpiresAt?: string;
  error?: string;
}

export interface BrowserProfileStatus {
  name: string;
  created_at: string;
  last_used?: string;
  cdp_port?: number;
  auth_markers: string[];
  has_state: boolean;
  running: boolean;
  cdpReady: boolean;
}
