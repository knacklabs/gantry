import type { AgentId } from '../../domain/agent/agent.js';
import type { PrincipalRef } from '../../domain/identity/principal-ref.js';

export interface AgentOffboardingRepository {
  offboard(input: {
    appId: string;
    agentId: AgentId;
    defaultAgentId: AgentId;
    expectedSettingsRevision: number;
    settingsDocument: Record<string, unknown>;
    createdBy: string;
    actor: PrincipalRef;
    now: string;
    minReaderVersion: number;
  }): Promise<
    | {
        status: 'offboarded';
        agentName: string;
        providerAccountsDisabled: number;
        conversationInstallsRemoved: number;
        jobsCancelled: number;
        settingsRevision: number;
      }
    | { status: 'already_offboarded' }
  >;
}

/** Durable AI-employee lifecycle operation; the repository owns its one transaction. */
export async function offboardAgent(input: {
  repository: AgentOffboardingRepository;
  appId: string;
  agentId: AgentId;
  defaultAgentId: AgentId;
  expectedSettingsRevision: number;
  settingsDocument: Record<string, unknown>;
  createdBy: string;
  actor: PrincipalRef;
  now: string;
  minReaderVersion: number;
}) {
  return input.repository.offboard({
    appId: input.appId,
    agentId: input.agentId,
    defaultAgentId: input.defaultAgentId,
    expectedSettingsRevision: input.expectedSettingsRevision,
    settingsDocument: input.settingsDocument,
    createdBy: input.createdBy,
    actor: input.actor,
    now: input.now,
    minReaderVersion: input.minReaderVersion,
  });
}
