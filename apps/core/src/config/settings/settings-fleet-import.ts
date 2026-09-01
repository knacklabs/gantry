import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import {
  McpBindingAuthorityChangedError,
  type McpBindingAuthorityPrecondition,
} from '../../domain/mcp/mcp-servers.js';
import type {
  SettingsRevision,
  SettingsRevisionRepository,
} from '../../domain/ports/fleet-capability-state.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '../../domain/provider/provider.js';
import { normalizeConfiguredCapabilitiesInSettings } from './configured-capability-normalization.js';
import { SettingsDesiredStateService } from './desired-state-service.js';
import type {
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
} from './desired-state-service.js';
import {
  mcpCapabilityGrantTokenKey,
  nextMcpCapabilityGrantTokens,
} from './mcp-capability-grant-provenance.js';
import {
  capturePendingMcpSourceEdits,
  restorePendingMcpSourceEdits,
} from './mcp-source-projection-preservation.js';
import {
  agentIdsFromMcpBindingPreconditions,
  revisionDocumentMatchesSettings,
  revisionMcpBindingPreconditionsMatch,
  settingsFromRevisionDocument,
  settingsToRevisionDocument,
} from './settings-revision-document.js';
import {
  PostgresSettingsRevisionNotifier,
  type SettingsRevisionWakeup,
} from './settings-revision-notify.js';
import { withRuntimeModelAliases } from './runtime-settings.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
import { validateLoadedRuntimeSettings } from './runtime-settings-validation.js';

type SettingsRevisionNotificationPool = ConstructorParameters<
  typeof PostgresSettingsRevisionNotifier
>[0];

export interface SettingsFleetProjectionOps {
  addAllMcpSourcesToRuntimeSettings(input: {
    settings: RuntimeSettings;
    repositories: Pick<SettingsDesiredStateRepositories, 'mcpServers'>;
    appId: AppId;
  }): Promise<McpBindingAuthorityPrecondition[]>;
  snapshotConfiguredMcpBindingAuthority(input: {
    settings: RuntimeSettings;
    repositories: Pick<SettingsDesiredStateRepositories, 'mcpServers'>;
    appId: AppId;
    additionalAgentIds?: readonly AgentId[];
  }): Promise<{
    agentIds: AgentId[];
    bindings: McpBindingAuthorityPrecondition[];
  }>;
}

/**
 * Reader version of the settings-revision contract this build understands. A
 * revision stamped with a higher `min_reader_version` than this is held (not
 * applied) by an older worker until it is upgraded (ADR-3 skew safety contract).
 * Bump this whenever a settings-schema change would break older readers.
 */
export const CURRENT_SETTINGS_READER_VERSION = 15;

export interface SettingsImportValidationResult {
  ok: boolean;
  settings: RuntimeSettings;
  /** Path-level error strings, identical for the YAML and API surfaces. */
  errors: string[];
  /** Tolerated findings (stored rule grants a tightened validator rejects). */
  warnings?: string[];
}

export interface SettingsImportServiceDeps {
  runtimeHome: string;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  appId?: AppId;
}

export class SettingsRevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(input: {
    expectedRevision: number;
    actualRevision: number;
    message?: string;
  }) {
    super(
      input.message ??
        `settings revision conflicted: expected revision ${input.expectedRevision}, actual revision ${input.actualRevision}`,
    );
    this.name = 'SettingsRevisionConflictError';
    this.expectedRevision = input.expectedRevision;
    this.actualRevision = input.actualRevision;
  }
}

/**
 * The single validation path shared by every settings mutation surface (YAML
 * watcher auto-import, CLI `settings import`, and the control-API desired-state
 * update).
 */
export async function validateSettingsForImport(
  deps: SettingsImportServiceDeps,
  settings: RuntimeSettings,
): Promise<SettingsImportValidationResult> {
  const errors: string[] = [];
  const schema = withRuntimeModelAliases(settings, () =>
    validateLoadedRuntimeSettings(deps.runtimeHome, settings),
  );
  if (!schema.ok && schema.failure) {
    errors.push(...schema.failure.details);
  }
  const service = new SettingsDesiredStateService({
    ops: deps.ops,
    repositories: deps.repositories,
    appId: deps.appId,
  });
  const invalidReferences =
    await service.validateCapabilityReferences(settings);
  errors.push(...invalidReferences);
  const { hardErrors, warnings } = partitionStoredRuleCapabilityErrors(errors);
  if (warnings.length > 0) {
    deps.logWarn?.(
      { warnings },
      'settings import tolerated stored capability rules the current validator rejects; they stay subject to decision-time policy',
    );
  }
  return { ok: hardErrors.length === 0, settings, errors: hardErrors, warnings };
}

// Stored RunCommand grants are machine-minted (Allow for future), so a later,
// stricter validator can retroactively reject entries that were legal when
// granted. That must never make settings unloadable (it crash-loops startup);
// the rules stay in settings and remain subject to decision-time rails and
// guards. Hand-authored capability ids keep strict rejection. String-keyed on
// the two per-entry error shapes because both validators emit flat strings.
export function partitionStoredRuleCapabilityErrors(errors: string[]): {
  hardErrors: string[];
  warnings: string[];
} {
  const storedRulePattern =
    /contains (?:invalid|unavailable) capability "?RunCommand\(/;
  const hardErrors: string[] = [];
  const warnings: string[] = [];
  for (const error of errors) {
    (storedRulePattern.test(error) ? warnings : hardErrors).push(error);
  }
  return { hardErrors, warnings };
}

type RecoveryRevisionMirror = {
  settingsRevisions: SettingsRevisionRepository;
  pool?: SettingsRevisionNotificationPool;
  createdBy: string;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
};

export async function appendRejectedMcpApprovalRecoveryRevision(input: {
  deps: SettingsImportServiceDeps & {
    revisionMirror: RecoveryRevisionMirror;
    expectedMcpBindingAgentIds?: AgentId[];
    expectedMcpBindings?: McpBindingAuthorityPrecondition[];
    reloadRuntimeState?: () => Promise<void>;
  };
  appId: AppId;
  failedRevision: number;
  previousSettings: RuntimeSettings;
  rejectedSettings: RuntimeSettings;
  rejectedMcpCapabilityGrantTokens?: Record<string, string>;
  projectionOps: SettingsFleetProjectionOps;
}): Promise<void> {
  const rejectedCapabilityKeysByFolder = new Map<string, Set<string>>();
  for (const [folder, rejectedAgent] of Object.entries(
    input.rejectedSettings.agents,
  )) {
    const previousCapabilityKeys = new Set(
      (input.previousSettings.agents[folder]?.capabilities ?? []).map(
        capabilitySelectionKey,
      ),
    );
    const rejectedCapabilityKeys = new Set(
      rejectedAgent.capabilities
        .filter((capability) => {
          if (previousCapabilityKeys.has(capabilitySelectionKey(capability))) {
            return false;
          }
          return Boolean(
            input.rejectedMcpCapabilityGrantTokens?.[
              mcpCapabilityGrantTokenKey(folder, capability)
            ],
          );
        })
        .map(capabilitySelectionKey),
    );
    if (rejectedCapabilityKeys.size > 0) {
      rejectedCapabilityKeysByFolder.set(folder, rejectedCapabilityKeys);
    }
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const latest =
      await input.deps.revisionMirror.settingsRevisions.getLatestSettingsRevision(
        input.appId,
      );
    if (!latest || latest.revision < input.failedRevision) {
      throw new Error(
        'MCP approval recovery could not load the rejected settings revision.',
      );
    }
    const recoverySettings = settingsFromRevisionDocument(
      latest.settingsDocument,
    );
    for (const [
      folder,
      rejectedCapabilityKeys,
    ] of rejectedCapabilityKeysByFolder) {
      const recoveryAgent = recoverySettings.agents[folder];
      if (!recoveryAgent) continue;
      recoveryAgent.capabilities = recoveryAgent.capabilities.filter(
        (capability) => {
          const selectionKey = capabilitySelectionKey(capability);
          if (!rejectedCapabilityKeys.has(selectionKey)) return true;
          const tokenKey = mcpCapabilityGrantTokenKey(folder, capability);
          const rejectedToken =
            input.rejectedMcpCapabilityGrantTokens?.[tokenKey];
          return latest.mcpCapabilityGrantTokens?.[tokenKey] !== rejectedToken;
        },
      );
    }
    const pendingMcpSourceEdits = capturePendingMcpSourceEdits({
      settings: recoverySettings,
      agentIds: latest.mcpBindingPreconditionAgentIds,
      bindings: latest.mcpBindingPreconditions,
    });
    const projectedBindings =
      await input.projectionOps.addAllMcpSourcesToRuntimeSettings({
        settings: recoverySettings,
        repositories: input.deps.repositories,
        appId: input.appId,
      });
    restorePendingMcpSourceEdits(recoverySettings, pendingMcpSourceEdits);
    const configuredAgentIds = Object.keys(recoverySettings.agents)
      .sort()
      .map((folder) => `agent:${folder}` as AgentId);
    const hasAdditionalFencedAgents = (
      latest.mcpBindingPreconditionAgentIds ?? []
    ).some((agentId) => !configuredAgentIds.includes(agentId));
    const currentSnapshot = hasAdditionalFencedAgents
      ? await input.projectionOps.snapshotConfiguredMcpBindingAuthority({
          settings: recoverySettings,
          repositories: input.deps.repositories,
          appId: input.appId,
          additionalAgentIds: latest.mcpBindingPreconditionAgentIds,
        })
      : { agentIds: configuredAgentIds, bindings: projectedBindings };
    const currentAgentIds = currentSnapshot.agentIds;
    const currentBindings = currentSnapshot.bindings;
    if (
      revisionDocumentMatchesSettings(
        latest.settingsDocument,
        recoverySettings,
      ) &&
      revisionMcpBindingPreconditionsMatch(
        latest.mcpBindingPreconditionAgentIds,
        latest.mcpBindingPreconditions,
        currentAgentIds,
        currentBindings,
      )
    ) {
      return;
    }
    try {
      const outcome = await importFleetSettingsRevisionWithProjectionOps(
        {
          runtimeHome: input.deps.runtimeHome,
          ops: input.deps.ops,
          repositories: input.deps.repositories,
          appId: input.appId,
          settingsRevisions: input.deps.revisionMirror.settingsRevisions,
          pool: input.deps.revisionMirror.pool,
          createdBy: input.deps.revisionMirror.createdBy,
          logWarn: input.deps.revisionMirror.logWarn,
        },
        recoverySettings,
        {
          expectedRevision: latest.revision,
          expectedMcpBindingAgentIds: currentAgentIds,
          expectedMcpBindings: currentBindings,
          note: 'Compensate rejected MCP capability approval.',
        },
        input.projectionOps,
      );
      if (outcome.status === 'invalid') {
        throw new Error(
          [
            'MCP approval recovery settings validation failed.',
            ...outcome.errors,
          ].join('\n'),
        );
      }
      if (outcome.status === 'applied') return;
      if (attempt === 3) {
        throw new SettingsRevisionConflictError(outcome);
      }
    } catch (err) {
      if (err instanceof McpBindingAuthorityChangedError && attempt < 3) {
        continue;
      }
      throw err;
    }
  }
}

function capabilitySelectionKey(input: {
  id: string;
  version: string;
}): string {
  return `${input.id}\0${input.version}`;
}

export function settingsWithoutMcpCapabilityGrantTokens(
  settings: RuntimeSettings,
  grantTokens: Record<string, string> | undefined,
): RuntimeSettings {
  if (!grantTokens || Object.keys(grantTokens).length === 0) return settings;
  const previous = structuredClone(settings);
  for (const [folder, agent] of Object.entries(previous.agents)) {
    agent.capabilities = agent.capabilities.filter(
      (capability) =>
        grantTokens[mcpCapabilityGrantTokenKey(folder, capability)] ===
        undefined,
    );
  }
  return previous;
}

export type FleetImportOutcome =
  | { status: 'applied'; revision: number }
  | { status: 'invalid'; errors: string[] }
  | { status: 'conflict'; expectedRevision: number; actualRevision: number };

export interface FleetImportDeps extends SettingsImportServiceDeps {
  settingsRevisions: SettingsRevisionRepository;
  /** Pool used to publish the `pg_notify` wakeup after a successful append. */
  pool?: SettingsRevisionNotificationPool;
  createdBy: string;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
}

export interface FleetImportOptions {
  expectedRevision?: number | null;
  latestRevision?: SettingsRevision | null;
  expectedMcpBindingAgentIds?: AgentId[];
  expectedMcpBindings?: McpBindingAuthorityPrecondition[];
  mcpCapabilityGrantTokens?: Record<string, string>;
  note?: string | null;
}

/**
 * Fleet import: validate through the same path, enforce stale-revision
 * optimistic concurrency, append a `settings_revisions` row, and publish a
 * `pg_notify` wakeup.
 */
export async function importFleetSettingsRevisionWithProjectionOps(
  deps: FleetImportDeps,
  settings: RuntimeSettings,
  options: FleetImportOptions,
  projectionOps: SettingsFleetProjectionOps,
): Promise<FleetImportOutcome> {
  const validation = await validateSettingsForImport(deps, settings);
  if (!validation.ok) {
    return { status: 'invalid', errors: validation.errors };
  }
  const appId = deps.appId ?? ('default' as AppId);
  let expectedRevision = options.expectedRevision;
  let expectedMcpBindingAgentIds =
    options.expectedMcpBindingAgentIds ??
    agentIdsFromMcpBindingPreconditions(options.expectedMcpBindings);
  let expectedMcpBindings = options.expectedMcpBindings;
  const latest =
    options.latestRevision === undefined
      ? await deps.settingsRevisions.getLatestSettingsRevision(appId)
      : options.latestRevision;
  let revisionSettings = settings;
  if (
    expectedMcpBindingAgentIds === undefined &&
    expectedMcpBindings === undefined
  ) {
    if ((latest?.mcpBindingPreconditionAgentIds?.length ?? 0) > 0) {
      revisionSettings = structuredClone(settings);
      const pendingMcpSourceEdits = capturePendingMcpSourceEdits({
        settings: revisionSettings,
        agentIds: latest?.mcpBindingPreconditionAgentIds,
        bindings: latest?.mcpBindingPreconditions,
      });
      await projectionOps.addAllMcpSourcesToRuntimeSettings({
        settings: revisionSettings,
        repositories: deps.repositories,
        appId,
      });
      restorePendingMcpSourceEdits(revisionSettings, pendingMcpSourceEdits);
      const snapshot =
        await projectionOps.snapshotConfiguredMcpBindingAuthority({
          settings: revisionSettings,
          repositories: deps.repositories,
          appId,
          additionalAgentIds: latest?.mcpBindingPreconditionAgentIds,
        });
      expectedRevision ??= latest!.revision;
      expectedMcpBindingAgentIds = snapshot.agentIds;
      expectedMcpBindings = snapshot.bindings;
    }
  }
  const appended = await deps.settingsRevisions.appendSettingsRevision({
    appId,
    settingsDocument: settingsToRevisionDocument(revisionSettings),
    minReaderVersion: CURRENT_SETTINGS_READER_VERSION,
    createdBy: deps.createdBy,
    note: options.note ?? null,
    expectedRevision: expectedRevision ?? null,
    expectedMcpBindingAgentIds,
    expectedMcpBindings,
    mcpCapabilityGrantTokens: nextMcpCapabilityGrantTokens({
      settings: revisionSettings,
      previous: latest?.mcpCapabilityGrantTokens,
      overrides: options.mcpCapabilityGrantTokens,
    }),
  });
  if (appended.status === 'conflict') {
    return {
      status: 'conflict',
      expectedRevision: appended.expectedRevision,
      actualRevision: appended.actualRevision,
    };
  }
  if (deps.pool) {
    const notifier = new PostgresSettingsRevisionNotifier(
      deps.pool,
      deps.logWarn,
    );
    const wakeup: SettingsRevisionWakeup = {
      appId,
      revision: appended.revision.revision,
    };
    await notifier.notifyRevisionChanged(wakeup);
  }
  return { status: 'applied', revision: appended.revision.revision };
}

export async function validateProjectionPreconditions(input: {
  settings: RuntimeSettings;
  repositories: SettingsDesiredStateRepositories;
  appId: AppId;
}): Promise<void> {
  const providerAccounts = input.repositories.providerAccounts;
  if (!providerAccounts) return;
  for (const [accountId, account] of Object.entries(
    input.settings.providerAccounts,
  )) {
    const existing = await providerAccounts.getProviderAccount(
      accountId as ProviderAccountId,
    );
    if (!existing) continue;
    if (existing.appId !== input.appId) {
      throw new Error(
        `provider_accounts.${accountId} already belongs to another app`,
      );
    }
    if (existing.providerId !== (account.provider as ProviderId)) {
      throw new Error(
        `provider_accounts.${accountId}.provider cannot change from ${existing.providerId} to ${account.provider}; use a new provider account id.`,
      );
    }
  }
}
