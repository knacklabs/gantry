import type { AgentRun, AgentRunEvent } from '../events/events.js';
import type {
  SandboxLease,
  SandboxProfile,
  WorkspaceSnapshot,
} from '../sandbox/sandbox.js';
import type { BrowserProfile } from '../browser/browser.js';

export interface SandboxProvider {
  acquireLease(input: {
    profile: SandboxProfile;
    run: AgentRun;
  }): Promise<SandboxLease>;
  releaseLease(lease: SandboxLease): Promise<void>;
}

export interface BrowserRuntimeProvider {
  ensureProfile(profile: BrowserProfile): Promise<void>;
  closeProfile(profile: BrowserProfile): Promise<void>;
}

export interface AgentRuntimeProvider {
  runAgent(input: {
    run: AgentRun;
    workspace: WorkspaceSnapshot;
  }): AsyncIterable<AgentRunEvent>;
}

export interface EventBus {
  publish(event: AgentRunEvent): Promise<void>;
  subscribe(input: { runId?: string }): AsyncIterable<AgentRunEvent>;
}

export interface CredentialStore {
  resolveRuntimeSecret(ref: string): Promise<string>;
  resolveAgentCredential(ref: string): Promise<Record<string, string>>;
}

export interface UnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}
